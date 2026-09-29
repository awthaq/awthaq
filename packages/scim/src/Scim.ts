// @awthaq/scim — Scim
//
// spec/behaviors/30-scim.md, BEH-EA-241 through 248; spec/models/12-scim.md;
// ADR-EA-023. `Auth.make([Organization, Scim])` composes: `Scim` `dependsOn:
// [Organization]` — a SCIM connection belongs to one organization, a provisioned
// user becomes a member of it, and a SCIM Group is one of its teams.
//
// The safety design, in one place (every rule has a test):
//
// - A connection acts ONLY on resources it provisioned. `scim_resource` is the
//   ownership map; a user or group with no row for the calling connection is a
//   plain 404, however it came to exist. `POST /Users` never adopts an existing
//   account by email (that would let one organization's directory claim, then
//   suspend, someone else's global identity — ADR-EA-018 Decision 4): an existing
//   email is `409 uniqueness`.
// - `userName` is immutable after creation (an IdP-driven email change would be an
//   account-takeover path); asking to change it is `400 mutability`.
// - `active: false` is suspension, never deletion: `Users.setStatus("suspended")`
//   then `Sessions.revokeAll`, so already-issued sessions die at once and
//   `Users.assertCanSignIn` (the one shared sign-in gate) refuses new ones.
//   `active: true` reactivates only a suspension this connection itself made
//   (its `statusReason` marker), so an administrator's ban is never lifted by a
//   directory sync.
// - `DELETE` is configurable: `deactivate` (default) or `erase` (`Users.delete`,
//   running the `BeforeUserDelete` erasure taps).
// - Group changes only ever touch the users this connection provisioned: a
//   `PUT /Groups` member list replaces *those*; other members of the team stay.
//
// `ScimConfig` is a `Context.Reference` with defaults (ADR-EA-011), read at layer
// build like every plugin's config.

import { AuthEvents, AuthPlugin, Migrations, Sessions, Users } from "@awthaq/core";
import {
  ActiveContextRecords,
  MembershipRecords,
  Organization,
  TeamRecords,
} from "@awthaq/organization";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as ScimApi from "./ScimApi.ts";
import * as ScimRecords from "./ScimRecords.ts";

// ---- config ---------------------------------------------------------------------------------

export interface ScimConfigShape {
  /** Prefixed onto `meta.location`; unset gives a root-relative location (`/scim/v2/Users/<id>`). */
  readonly baseUrl: Option.Option<string>;
  /** What `DELETE /Users/:id` does: suspend (default, reversible) or erase the user. */
  readonly deleteBehavior: "deactivate" | "erase";
  /** The organization role a provisioned user is added with. */
  readonly memberRole: string;
  /** Largest `count` a list request may take. */
  readonly maxResults: number;
}

const defaultScimConfig: ScimConfigShape = {
  baseUrl: Option.none(),
  deleteBehavior: "deactivate",
  memberRole: "member",
  maxResults: 200,
};

export const ScimConfig: Context.Reference<ScimConfigShape> = Context.Reference(
  "awthaq/scim/Config",
  { defaultValue: () => defaultScimConfig },
);

export const config = (partial: Partial<ScimConfigShape>) =>
  Layer.succeed(ScimConfig, { ...defaultScimConfig, ...partial });

// ---- shape -----------------------------------------------------------------------------------

type Connection = ScimApi.ScimConnectionIdentity;

export interface ScimShape {
  readonly listUsers: (
    connection: Connection,
    query: ScimApi.ListQuery,
  ) => Effect.Effect<ScimApi.UserListResponse, ScimApi.ScimBadRequest>;
  readonly createUser: (
    connection: Connection,
    input: ScimApi.UserInput,
  ) => Effect.Effect<
    ScimApi.UserResource,
    ScimApi.ScimBadRequest | ScimApi.ScimConflict | ScimApi.ScimForbidden
  >;
  readonly getUser: (
    connection: Connection,
    id: string,
  ) => Effect.Effect<ScimApi.UserResource, ScimApi.ScimNotFound>;
  readonly replaceUser: (
    connection: Connection,
    id: string,
    input: ScimApi.UserInput,
  ) => Effect.Effect<
    ScimApi.UserResource,
    ScimApi.ScimBadRequest | ScimApi.ScimNotFound | ScimApi.ScimConflict
  >;
  readonly patchUser: (
    connection: Connection,
    id: string,
    patch: ScimApi.PatchRequest,
  ) => Effect.Effect<
    ScimApi.UserResource,
    ScimApi.ScimBadRequest | ScimApi.ScimNotFound | ScimApi.ScimConflict
  >;
  readonly deleteUser: (
    connection: Connection,
    id: string,
  ) => Effect.Effect<void, ScimApi.ScimNotFound>;
  readonly listGroups: (
    connection: Connection,
    query: ScimApi.ListQuery,
  ) => Effect.Effect<ScimApi.GroupListResponse, ScimApi.ScimBadRequest>;
  readonly createGroup: (
    connection: Connection,
    input: ScimApi.GroupInput,
  ) => Effect.Effect<
    ScimApi.GroupResource,
    ScimApi.ScimBadRequest | ScimApi.ScimConflict | ScimApi.ScimForbidden
  >;
  readonly getGroup: (
    connection: Connection,
    id: string,
  ) => Effect.Effect<ScimApi.GroupResource, ScimApi.ScimNotFound>;
  readonly replaceGroup: (
    connection: Connection,
    id: string,
    input: ScimApi.GroupInput,
  ) => Effect.Effect<
    ScimApi.GroupResource,
    ScimApi.ScimBadRequest | ScimApi.ScimNotFound | ScimApi.ScimConflict | ScimApi.ScimForbidden
  >;
  readonly patchGroup: (
    connection: Connection,
    id: string,
    patch: ScimApi.PatchRequest,
  ) => Effect.Effect<
    ScimApi.GroupResource,
    ScimApi.ScimBadRequest | ScimApi.ScimNotFound | ScimApi.ScimConflict | ScimApi.ScimForbidden
  >;
  readonly deleteGroup: (
    connection: Connection,
    id: string,
  ) => Effect.Effect<void, ScimApi.ScimNotFound | ScimApi.ScimConflict>;
}

// ---- pure helpers ----------------------------------------------------------------------------

/** The `statusReason` a SCIM deactivation is stamped with, so only that connection lifts it. */
const suspensionMarker = (connectionId: string): string => `scim:${connectionId}`;

/** A boolean as IdPs send it: a JSON boolean, or Entra's `"True"`/`"False"` strings. */
const coerceBoolean = (value: unknown): Option.Option<boolean> => {
  if (typeof value === "boolean") return Option.some(value);
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return Option.some(true);
    if (lowered === "false") return Option.some(false);
  }
  return Option.none();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOf = (value: unknown): Option.Option<string> =>
  typeof value === "string" && value.trim() !== "" ? Option.some(value.trim()) : Option.none();

/** `attr eq "value"` — the only filter shape a directory uses to find its own resource. */
const parseEqFilter = (
  filter: string | undefined,
  attributes: ReadonlyArray<string>,
): Effect.Effect<Option.Option<{ readonly attribute: string; readonly value: string }>, ScimApi.ScimBadRequest> => {
  if (filter === undefined || filter.trim() === "") return Effect.succeed(Option.none());
  const match = /^\s*([A-Za-z][A-Za-z0-9.]*)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(filter);
  const attribute = attributes.find((name) => name.toLowerCase() === match?.[1]?.toLowerCase());
  const raw = match?.[2];
  return attribute === undefined || raw === undefined
    ? Effect.fail(
        ScimApi.badRequest(
          `Unsupported filter: only ${attributes.map((name) => `${name} eq "..."`).join(" or ")} are supported`,
          "invalidFilter",
        ),
      )
    : Effect.succeed(Option.some({ attribute, value: raw.replace(/\\(.)/g, "$1") }));
};

/** RFC 7644 §3.4.2.4: `startIndex` is 1-based (values below 1 are 1); `count` is bounded and may be 0. */
const paging = (query: ScimApi.ListQuery, maxResults: number) => {
  const startIndex = Math.max(1, Math.floor(query.startIndex ?? 1));
  const count = Math.min(maxResults, Math.max(0, Math.floor(query.count ?? maxResults)));
  return { startIndex, count, offset: startIndex - 1 };
};

const splitName = (name: string): { readonly given: string; readonly family: string } => {
  const at = name.indexOf(" ");
  return at < 0
    ? { given: name, family: "" }
    : { given: name.slice(0, at), family: name.slice(at + 1) };
};

const joinName = (given: string, family: string): string => [given, family].filter((part) => part !== "").join(" ");

/** The user's display name from a resource body: `displayName`, else `name.formatted`, else given + family, else `userName`. */
const nameFromInput = (input: ScimApi.UserInput): string =>
  Option.getOrElse(
    Option.orElse(
      stringOf(input.displayName),
      () =>
        Option.orElse(stringOf(input.name?.formatted), () => {
          const joined = joinName(input.name?.givenName?.trim() ?? "", input.name?.familyName?.trim() ?? "");
          return joined === "" ? Option.none() : Option.some(joined);
        }),
    ),
    () => input.userName.trim(),
  );

/** The email a user resource carries: the primary (else first) `emails[]` value, else a `userName` that is an address. */
const emailFromInput = (input: ScimApi.UserInput): Option.Option<string> => {
  const emails = input.emails ?? [];
  const primary = emails.find((email) => email.primary === true) ?? emails[0];
  const candidate = Option.orElse(stringOf(primary?.value), () =>
    input.userName.includes("@") ? stringOf(input.userName) : Option.none(),
  );
  return Option.map(candidate, (email) => email.toLowerCase());
};

// ---- PATCH interpretation -------------------------------------------------------------------------

/** What a PATCH body asks to change on a user, after normalization. */
interface UserChanges {
  readonly active: Option.Option<boolean>;
  readonly userName: Option.Option<string>;
  readonly displayName: Option.Option<string>;
  readonly givenName: Option.Option<string>;
  readonly familyName: Option.Option<string>;
  /** `Some(None)` clears it. */
  readonly externalId: Option.Option<Option.Option<string>>;
}

const noChanges: UserChanges = {
  active: Option.none(),
  userName: Option.none(),
  displayName: Option.none(),
  givenName: Option.none(),
  familyName: Option.none(),
  externalId: Option.none(),
};

/** Folds one `{ attribute: value }` assignment into `changes`. Attributes this plugin does not manage are ignored (IdPs send many). */
const assign = (changes: UserChanges, attribute: string, value: unknown): UserChanges => {
  switch (attribute.toLowerCase()) {
    case "active":
      return { ...changes, active: Option.orElse(coerceBoolean(value), () => changes.active) };
    case "username":
      return { ...changes, userName: stringOf(value) };
    case "displayname":
      return { ...changes, displayName: stringOf(value) };
    case "name.givenname":
      return { ...changes, givenName: stringOf(value) };
    case "name.familyname":
      return { ...changes, familyName: stringOf(value) };
    case "name.formatted":
      return { ...changes, displayName: stringOf(value) };
    case "name":
      return isRecord(value)
        ? assign(
            assign(assign(changes, "name.givenName", value["givenName"]), "name.familyName", value["familyName"]),
            "name.formatted",
            value["formatted"],
          )
        : changes;
    case "externalid":
      return { ...changes, externalId: Option.some(stringOf(value)) };
    default:
      return changes;
  }
};

const interpretUserPatch = (
  patch: ScimApi.PatchRequest,
): Effect.Effect<UserChanges, ScimApi.ScimBadRequest> =>
  Effect.gen(function* () {
    let changes = noChanges;
    for (const operation of patch.Operations) {
      const op = operation.op.trim().toLowerCase();
      if (op !== "add" && op !== "replace" && op !== "remove") {
        return yield* ScimApi.badRequest(`Unknown patch op "${operation.op}"`, "invalidSyntax");
      }
      if (operation.path === undefined || operation.path.trim() === "") {
        // No path: `value` is an object of attributes (Okta's `{ "active": false }` form).
        if (op !== "remove" && isRecord(operation.value)) {
          for (const [attribute, value] of Object.entries(operation.value)) {
            changes = assign(changes, attribute, value);
          }
        }
        continue;
      }
      if (op === "remove") {
        // The only removable attribute this plugin manages is the external id.
        if (operation.path.trim().toLowerCase() === "externalid") {
          changes = { ...changes, externalId: Option.some(Option.none()) };
        }
        continue;
      }
      changes = assign(changes, operation.path.trim(), operation.value);
    }
    return changes;
  });

// ---- the plugin ------------------------------------------------------------------------------------

const scimMigrations: Migrations.Migrations = [
  {
    name: "create_scim_connection",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE scim_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "tokenHash" TEXT NOT NULL UNIQUE,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "revokedAt" TIMESTAMPTZ
          )`,
        sqlite: () => sql`
          CREATE TABLE scim_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            name TEXT NOT NULL,
            "tokenHash" TEXT NOT NULL UNIQUE,
            "createdAt" TEXT NOT NULL,
            "revokedAt" TEXT
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
      yield* sql`CREATE INDEX scim_connection_organization_id ON scim_connection("organizationId")`;
    }),
  },
  {
    // `name` (a user's directory `userName`) and `externalId` are each unique per connection and
    // kind; both are nullable, and a NULL never collides. Named unique indexes, so a violation
    // says which rule it broke.
    name: "create_scim_resource",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE scim_resource (
            "scimConnectionId" TEXT NOT NULL,
            kind TEXT NOT NULL,
            "resourceId" TEXT NOT NULL,
            name TEXT,
            "externalId" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL,
            PRIMARY KEY ("scimConnectionId", kind, "resourceId")
          )`,
        sqlite: () => sql`
          CREATE TABLE scim_resource (
            "scimConnectionId" TEXT NOT NULL,
            kind TEXT NOT NULL,
            "resourceId" TEXT NOT NULL,
            name TEXT,
            "externalId" TEXT,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL,
            PRIMARY KEY ("scimConnectionId", kind, "resourceId")
          )`,
        orElse: () => Effect.die(new Error("awthaq: unsupported SQL dialect for migrations")),
      });
      yield* sql`CREATE UNIQUE INDEX scim_resource_name_unique ON scim_resource("scimConnectionId", kind, name)`;
      yield* sql`CREATE UNIQUE INDEX scim_resource_external_id_unique ON scim_resource("scimConnectionId", kind, "externalId")`;
    }),
  },
];

export class Scim extends AuthPlugin.Service<Scim, ScimShape>()("scim", {
  apiVersion: 1,
  contract: ScimApi.ScimApi,
  tables: ["scim_connection", "scim_resource"],
  migrations: scimMigrations,
}) {
  static readonly layer = AuthPlugin.layer(Scim, {
    dependsOn: [Organization.Organization],
    handlers: HttpApiBuilder.group(
      ScimApi.ScimApi,
      "scim",
      Effect.fnUntraced(function* (handlers) {
        const scim = yield* Scim;
        return handlers.handleAll({
          serviceProviderConfig: () => Effect.succeed(serviceProviderConfig),
          resourceTypes: () => Effect.succeed(resourceTypes),
          schemas: () => Effect.succeed(schemaDescriptions),
          listUsers: Effect.fnUntraced(function* ({ query }: { query: ScimApi.ListQuery }) {
            return yield* scim.listUsers(yield* ScimApi.CurrentScimConnection, query);
          }),
          createUser: Effect.fnUntraced(function* ({ payload }: { payload: ScimApi.UserInput }) {
            return yield* scim.createUser(yield* ScimApi.CurrentScimConnection, payload);
          }),
          getUser: Effect.fnUntraced(function* ({ params }: { params: ScimApi.IdParams }) {
            return yield* scim.getUser(yield* ScimApi.CurrentScimConnection, params.id);
          }),
          replaceUser: Effect.fnUntraced(function* ({
            params,
            payload,
          }: {
            params: ScimApi.IdParams;
            payload: ScimApi.UserInput;
          }) {
            return yield* scim.replaceUser(yield* ScimApi.CurrentScimConnection, params.id, payload);
          }),
          patchUser: Effect.fnUntraced(function* ({
            params,
            payload,
          }: {
            params: ScimApi.IdParams;
            payload: ScimApi.PatchRequest;
          }) {
            return yield* scim.patchUser(yield* ScimApi.CurrentScimConnection, params.id, payload);
          }),
          deleteUser: Effect.fnUntraced(function* ({ params }: { params: ScimApi.IdParams }) {
            yield* scim.deleteUser(yield* ScimApi.CurrentScimConnection, params.id);
          }),
          listGroups: Effect.fnUntraced(function* ({ query }: { query: ScimApi.ListQuery }) {
            return yield* scim.listGroups(yield* ScimApi.CurrentScimConnection, query);
          }),
          createGroup: Effect.fnUntraced(function* ({ payload }: { payload: ScimApi.GroupInput }) {
            return yield* scim.createGroup(yield* ScimApi.CurrentScimConnection, payload);
          }),
          getGroup: Effect.fnUntraced(function* ({ params }: { params: ScimApi.IdParams }) {
            return yield* scim.getGroup(yield* ScimApi.CurrentScimConnection, params.id);
          }),
          replaceGroup: Effect.fnUntraced(function* ({
            params,
            payload,
          }: {
            params: ScimApi.IdParams;
            payload: ScimApi.GroupInput;
          }) {
            return yield* scim.replaceGroup(yield* ScimApi.CurrentScimConnection, params.id, payload);
          }),
          patchGroup: Effect.fnUntraced(function* ({
            params,
            payload,
          }: {
            params: ScimApi.IdParams;
            payload: ScimApi.PatchRequest;
          }) {
            return yield* scim.patchGroup(yield* ScimApi.CurrentScimConnection, params.id, payload);
          }),
          deleteGroup: Effect.fnUntraced(function* ({ params }: { params: ScimApi.IdParams }) {
            yield* scim.deleteGroup(yield* ScimApi.CurrentScimConnection, params.id);
          }),
        });
      }),
    ),
    make: Effect.gen(function* () {
      const events = yield* AuthEvents.AuthEvents;
      const users = yield* Users.Users;
      const sessions = yield* Sessions.Sessions;
      const organization = yield* Organization.Organization;
      const records = yield* ScimRecords.ScimRecords;
      const members = yield* MembershipRecords.MembershipRecords;
      const teams = yield* TeamRecords.TeamRecords;
      const activeContext = yield* ActiveContextRecords.ActiveContextRecords;
      const cfg = yield* ScimConfig;

      const locate = (kind: "Users" | "Groups", id: string): string =>
        `${Option.getOrElse(cfg.baseUrl, () => "")}/scim/v2/${kind}/${id}`;

      // ---- resources --------------------------------------------------------------------------

      const userResource = (
        user: Users.UserRecord,
        link: ScimRecords.ResourceLink,
      ): ScimApi.UserResource => {
        const email = Users.emailOf(user);
        return {
          schemas: [ScimApi.USER_SCHEMA],
          id: user.id,
          ...Option.match(link.externalId, {
            onNone: () => ({}),
            onSome: (externalId) => ({ externalId }),
          }),
          userName: Option.getOrElse(link.name, () => Option.getOrElse(email, () => user.id)),
          name: { formatted: user.name },
          displayName: user.name,
          ...Option.match(email, {
            onNone: () => ({}),
            onSome: (value) => ({ emails: [{ value, primary: true }] }),
          }),
          active: user.status === "active",
          meta: {
            resourceType: "User",
            created: DateTime.formatIso(user.createdAt),
            lastModified: DateTime.formatIso(user.updatedAt),
            location: locate("Users", user.id),
          },
        };
      };

      /** The link and the user it names, for a connection's own user `id`; anything else is `404`. */
      const ownedUser = Effect.fnUntraced(function* (connection: Connection, id: string) {
        const link = yield* records.find(connection.id, "User", id);
        if (Option.isNone(link)) return yield* ScimApi.notFound(`User ${id} not found`);
        const user = yield* users
          .findById(Users.UserId(id))
          .pipe(
            Effect.catchTag("UserNotFound", () =>
              // The user was erased elsewhere: the mapping is stale, so drop it and report not found.
              records
                .unlink(connection.id, "User", id)
                .pipe(Effect.andThen(Effect.fail(ScimApi.notFound(`User ${id} not found`)))),
            ),
          );
        return { link: link.value, user };
      });

      const membershipAdded = (connection: Connection, userId: Users.UserId) =>
        organization
          .addMember({
            organizationId: connection.organizationId,
            userId,
            role: [cfg.memberRole],
          })
          .pipe(
            // Already a member (a re-provision): fine, the goal state holds.
            Effect.catchTag("AlreadyMember", () => Effect.void),
            Effect.asVoid,
          );

      // ---- lifecycle ---------------------------------------------------------------------------

      /**
       * BEH-EA-245: `active` is suspension. Deactivating suspends and ends every session; reactivating
       * lifts only a suspension this connection made. Returns the user as it stands afterwards.
       */
      const applyActive = Effect.fnUntraced(function* (
        connection: Connection,
        user: Users.UserRecord,
        active: boolean,
      ) {
        const marker = suspensionMarker(connection.id);
        if (!active && user.status === "active") {
          const suspended = yield* users
            .setStatus(user.id, "suspended", { reason: marker })
            .pipe(Effect.orDie);
          yield* sessions.revokeAll(user.id, "suspended");
          yield* events.publish({
            _tag: "auth.scim.userDeactivated",
            connectionId: connection.id,
            organizationId: connection.organizationId,
            userId: user.id,
          });
          return suspended;
        }
        if (
          active &&
          user.status === "suspended" &&
          Option.getOrNull(user.statusReason) === marker
        ) {
          const reactivated = yield* users.setStatus(user.id, "active").pipe(Effect.orDie);
          yield* events.publish({
            _tag: "auth.scim.userReactivated",
            connectionId: connection.id,
            organizationId: connection.organizationId,
            userId: user.id,
          });
          return reactivated;
        }
        return user;
      });

      // ---- Users ------------------------------------------------------------------------------------

      const listUsers: ScimShape["listUsers"] = Effect.fnUntraced(function* (connection, query) {
        const filter = yield* parseEqFilter(query.filter, ["userName", "externalId"]);
        const { startIndex, count, offset } = paging(query, cfg.maxResults);
        const { items, total } = yield* Option.match(filter, {
          onNone: () => records.list(connection.id, "User", { offset, limit: count }),
          onSome: ({ attribute, value }) =>
            (attribute === "userName"
              ? records.findByName(connection.id, "User", value)
              : records.findByExternalId(connection.id, "User", value)
            ).pipe(
              Effect.map((found) => {
                const all = Option.toArray(found);
                return { items: all.slice(offset, offset + count), total: all.length };
              }),
            ),
        });
        const resources = yield* Effect.forEach(items, (link) =>
          users.findById(Users.UserId(link.resourceId)).pipe(
            Effect.map((user) => Option.some(userResource(user, link))),
            Effect.catchTag("UserNotFound", () => Effect.succeedNone),
          ),
        );
        return {
          schemas: [ScimApi.LIST_SCHEMA],
          totalResults: total,
          startIndex,
          itemsPerPage: items.length,
          Resources: resources.flatMap((resource) => Option.toArray(resource)),
        };
      });

      const createUser: ScimShape["createUser"] = Effect.fnUntraced(function* (connection, input) {
        const userName = input.userName.trim();
        if (userName === "" || userName.length > 320) {
          return yield* ScimApi.badRequest("userName is required (at most 320 characters)");
        }
        const wantActive = input.active ?? true;

        // A repeat POST converges: the same externalId (or userName) already provisioned by this
        // connection is returned, reactivated if the directory now wants it active.
        const existingByExternal =
          input.externalId === undefined || input.externalId.trim() === ""
            ? Option.none<ScimRecords.ResourceLink>()
            : yield* records.findByExternalId(connection.id, "User", input.externalId.trim());
        if (Option.isSome(existingByExternal)) {
          const owned = yield* ownedUser(connection, existingByExternal.value.resourceId).pipe(
            Effect.catchTag("ScimNotFound", () =>
              Effect.fail(ScimApi.conflict(`externalId ${input.externalId ?? ""} is already provisioned`)),
            ),
          );
          const settled = yield* applyActive(connection, owned.user, wantActive);
          return userResource(settled, owned.link);
        }
        if (Option.isSome(yield* records.findByName(connection.id, "User", userName))) {
          return yield* ScimApi.conflict(`userName ${userName} is already provisioned`);
        }

        const email = emailFromInput(input);
        // ADR-EA-023 Decision 5: never adopt an existing account.
        if (Option.isSome(email) && Option.isSome(yield* users.findByEmail(email.value))) {
          return yield* ScimApi.conflict(`An account for ${email.value} already exists`);
        }
        const created = yield* users
          .create({
            identity: Option.match(email, {
              onNone: () => ({ _tag: "Anonymous" as const }),
              onSome: (value) => ({ _tag: "Email" as const, email: value }),
            }),
            name: nameFromInput(input),
          })
          .pipe(
            Effect.catchTags({
              EmailAlreadyExists: () =>
                Effect.fail(ScimApi.conflict(`An account for ${Option.getOrElse(email, () => userName)} already exists`)),
              PhoneAlreadyExists: (error) => Effect.die(error),
              PlatformError: (error) => Effect.die(error),
            }),
          );

        /** The user exists but is not (fully) provisioned: remove it so a failed POST leaves nothing behind. */
        const rollBack = records
          .unlink(connection.id, "User", created.id)
          .pipe(
            Effect.andThen(users.delete(created.id)),
            Effect.catch(() => Effect.void),
          );

        const link = yield* records
          .link({
            connectionId: connection.id,
            kind: "User",
            resourceId: created.id,
            name: userName,
            externalId: input.externalId?.trim() === "" ? undefined : input.externalId?.trim(),
          })
          .pipe(
            Effect.catchTag("ScimLinkConflict", (error) =>
              rollBack.pipe(
                Effect.andThen(
                  Effect.fail(
                    ScimApi.conflict(
                      error.field === "externalId"
                        ? `externalId ${input.externalId ?? ""} is already provisioned`
                        : `userName ${userName} is already provisioned`,
                    ),
                  ),
                ),
              ),
            ),
          );
        yield* membershipAdded(connection, created.id).pipe(
          Effect.catchTags({
            MembershipLimitReached: () =>
              rollBack.pipe(
                Effect.andThen(Effect.fail(ScimApi.forbidden("The organization's membership limit is reached"))),
              ),
            HookAborted: (aborted) =>
              rollBack.pipe(Effect.andThen(Effect.fail(ScimApi.forbidden(aborted.message)))),
            OrganizationNotFound: () =>
              rollBack.pipe(Effect.andThen(Effect.fail(ScimApi.forbidden("The organization is not available")))),
            UnknownOrgRole: () =>
              rollBack.pipe(Effect.andThen(Effect.fail(ScimApi.forbidden("The configured member role is unknown")))),
          }),
        );
        const settled = wantActive ? created : yield* applyActive(connection, created, false);
        yield* events.publish({
          _tag: "auth.scim.userProvisioned",
          connectionId: connection.id,
          organizationId: connection.organizationId,
          userId: created.id,
        });
        return userResource(settled, link);
      });

      const getUser: ScimShape["getUser"] = (connection, id) =>
        ownedUser(connection, id).pipe(Effect.map(({ user, link }) => userResource(user, link)));

      /** Applies `changes` to an owned user, in the order that leaves a consistent state if a step fails. */
      const applyUserChanges = Effect.fnUntraced(function* (
        connection: Connection,
        owned: { readonly link: ScimRecords.ResourceLink; readonly user: Users.UserRecord },
        changes: UserChanges,
      ) {
        // Immutable identity: the directory may re-send its own userName, never change it.
        if (
          Option.isSome(changes.userName) &&
          changes.userName.value.toLowerCase() !==
            Option.getOrElse(owned.link.name, () => "").toLowerCase()
        ) {
          return yield* ScimApi.badRequest("userName cannot be changed after creation", "mutability");
        }
        let link = owned.link;
        if (Option.isSome(changes.externalId)) {
          link = yield* records
            .setExternalId(
              connection.id,
              "User",
              owned.user.id,
              Option.getOrNull(changes.externalId.value),
            )
            .pipe(
              Effect.catchTags({
                ScimLinkConflict: () =>
                  Effect.fail(ScimApi.conflict("externalId is already provisioned")),
                ScimRecordNotFound: () => Effect.fail(ScimApi.notFound()),
              }),
            );
        }
        let user = owned.user;
        const parts = splitName(user.name);
        const nextName = Option.isSome(changes.displayName)
          ? changes.displayName.value
          : Option.isSome(changes.givenName) || Option.isSome(changes.familyName)
            ? joinName(
                Option.getOrElse(changes.givenName, () => parts.given),
                Option.getOrElse(changes.familyName, () => parts.family),
              )
            : user.name;
        if (nextName !== user.name && nextName !== "") {
          user = yield* users
            .updateProfile(user.id, { name: nextName })
            .pipe(Effect.catchTag("UserNotFound", () => Effect.fail(ScimApi.notFound())));
        }
        if (Option.isSome(changes.active)) {
          user = yield* applyActive(connection, user, changes.active.value);
        }
        return { user, link };
      });

      const replaceUser: ScimShape["replaceUser"] = Effect.fnUntraced(function* (connection, id, input) {
        const owned = yield* ownedUser(connection, id);
        // PUT replaces the writable attributes: an absent `externalId` clears it.
        const externalId = stringOf(input.externalId);
        const changes: UserChanges = {
          ...noChanges,
          userName: Option.some(input.userName),
          displayName: Option.some(nameFromInput(input)),
          externalId: Option.some(externalId),
          active: Option.fromNullishOr(input.active),
        };
        const { user, link } = yield* applyUserChanges(connection, owned, changes);
        return userResource(user, link);
      });

      const patchUser: ScimShape["patchUser"] = Effect.fnUntraced(function* (connection, id, patch) {
        const owned = yield* ownedUser(connection, id);
        const changes = yield* interpretUserPatch(patch);
        const { user, link } = yield* applyUserChanges(connection, owned, changes);
        return userResource(user, link);
      });

      const deleteUser: ScimShape["deleteUser"] = Effect.fnUntraced(function* (connection, id) {
        const owned = yield* ownedUser(connection, id);
        if (cfg.deleteBehavior === "erase") {
          yield* sessions.revokeAll(owned.user.id, "userDeleted");
          yield* records.unlink(connection.id, "User", owned.user.id);
          yield* users
            .delete(owned.user.id)
            .pipe(Effect.catchTag("UserNotFound", () => Effect.void), Effect.orDie);
          yield* events.publish({
            _tag: "auth.scim.userDeleted",
            connectionId: connection.id,
            organizationId: connection.organizationId,
            userId: owned.user.id,
          });
          return;
        }
        yield* applyActive(connection, owned.user, false);
      });

      // ---- Groups (organization teams) --------------------------------------------------------------

      /** A group's team, or `404` (and a stale mapping dropped) when the team was removed elsewhere. */
      const ownedGroup = Effect.fnUntraced(function* (connection: Connection, id: string) {
        const link = yield* records.find(connection.id, "Group", id);
        if (Option.isNone(link)) return yield* ScimApi.notFound(`Group ${id} not found`);
        const team = yield* teams.findTeamById(connection.organizationId, id);
        if (Option.isNone(team)) {
          yield* records.unlink(connection.id, "Group", id);
          return yield* ScimApi.notFound(`Group ${id} not found`);
        }
        return { link: link.value, team: team.value };
      });

      /** The team members this connection provisioned — the only ones a directory can see or change. */
      const provisionedMembers = Effect.fnUntraced(function* (connection: Connection, teamId: string) {
        const rows = yield* teams.listTeamMembers(teamId);
        const owned = yield* Effect.filter(rows, (row) =>
          Effect.map(records.find(connection.id, "User", row.userId), Option.isSome),
        );
        return owned.map((row) => row.userId as string);
      });

      const groupResource = Effect.fnUntraced(function* (
        connection: Connection,
        owned: { readonly link: ScimRecords.ResourceLink; readonly team: TeamRecords.TeamRecord },
      ) {
        const memberIds = yield* provisionedMembers(connection, owned.team.id);
        return {
          schemas: [ScimApi.GROUP_SCHEMA],
          id: owned.team.id,
          ...Option.match(owned.link.externalId, {
            onNone: () => ({}),
            onSome: (externalId) => ({ externalId }),
          }),
          displayName: owned.team.name,
          members: memberIds.map((value) => ({ value })),
          meta: {
            resourceType: "Group",
            created: DateTime.formatIso(owned.team.createdAt),
            lastModified: DateTime.formatIso(owned.link.updatedAt),
            location: locate("Groups", owned.team.id),
          },
        } satisfies ScimApi.GroupResource;
      });

      /** Every requested member must be a user this connection provisioned and an organization member. */
      const requireMembers = Effect.fnUntraced(function* (
        connection: Connection,
        userIds: ReadonlyArray<string>,
      ) {
        for (const userId of userIds) {
          const link = yield* records.find(connection.id, "User", userId);
          const membership = Option.isSome(link)
            ? yield* members.findByUserAndOrg(Users.UserId(userId), connection.organizationId)
            : Option.none();
          if (Option.isNone(link) || Option.isNone(membership)) {
            return yield* ScimApi.badRequest(
              `Member ${userId} is not a user this connection provisioned`,
              "invalidValue",
            );
          }
        }
      });

      const addToTeam = (teamId: string, userId: string) =>
        teams
          .addTeamMember({ teamId, userId: Users.UserId(userId) })
          .pipe(Effect.catchTag("TeamMembershipRecordAlreadyExists", () => Effect.void));

      const removeFromTeam = (teamId: string, userId: string) =>
        teams
          .removeTeamMember(teamId, Users.UserId(userId))
          .pipe(Effect.catchTag("TeamMembershipRecordNotFound", () => Effect.void));

      /** Sets the provisioned members of a team to exactly `wanted`; unprovisioned members are untouched. */
      const replaceProvisioned = Effect.fnUntraced(function* (
        connection: Connection,
        teamId: string,
        wanted: ReadonlyArray<string>,
      ) {
        const current = yield* provisionedMembers(connection, teamId);
        yield* Effect.forEach(
          wanted.filter((userId) => !current.includes(userId)),
          (userId) => addToTeam(teamId, userId),
          { discard: true },
        );
        yield* Effect.forEach(
          current.filter((userId) => !wanted.includes(userId)),
          (userId) => removeFromTeam(teamId, userId),
          { discard: true },
        );
      });

      const listGroups: ScimShape["listGroups"] = Effect.fnUntraced(function* (connection, query) {
        const filter = yield* parseEqFilter(query.filter, ["displayName", "externalId"]);
        const { startIndex, count, offset } = paging(query, cfg.maxResults);
        const page = yield* records.list(connection.id, "Group", { offset: 0, limit: 10_000 });
        const owned = yield* Effect.forEach(page.items, (link) =>
          teams
            .findTeamById(connection.organizationId, link.resourceId)
            .pipe(Effect.map(Option.map((team) => ({ link, team })))),
        );
        const live = owned.flatMap((row) => Option.toArray(row));
        const matching = Option.match(filter, {
          onNone: () => live,
          onSome: ({ attribute, value }) =>
            live.filter((row) =>
              attribute === "displayName"
                ? row.team.name === value
                : Option.getOrNull(row.link.externalId) === value,
            ),
        });
        const slice = matching.slice(offset, offset + count);
        const resources = yield* Effect.forEach(slice, (row) => groupResource(connection, row));
        return {
          schemas: [ScimApi.LIST_SCHEMA],
          totalResults: matching.length,
          startIndex,
          itemsPerPage: resources.length,
          Resources: resources,
        };
      });

      const createGroup: ScimShape["createGroup"] = Effect.fnUntraced(function* (connection, input) {
        const displayName = input.displayName.trim();
        if (displayName === "" || displayName.length > 255) {
          return yield* ScimApi.badRequest("displayName is required (at most 255 characters)");
        }
        const externalId = stringOf(input.externalId);
        if (Option.isSome(externalId)) {
          const existing = yield* records.findByExternalId(connection.id, "Group", externalId.value);
          if (Option.isSome(existing)) {
            // A repeat POST converges on the group it already made.
            const owned = yield* ownedGroup(connection, existing.value.resourceId).pipe(
              Effect.catchTag("ScimNotFound", () =>
                Effect.fail(ScimApi.conflict(`externalId ${externalId.value} is already provisioned`)),
              ),
            );
            return yield* groupResource(connection, owned);
          }
        }
        const memberIds = (input.members ?? []).map((member) => member.value);
        yield* requireMembers(connection, memberIds);
        const team = yield* teams
          .createTeam({ organizationId: connection.organizationId, name: displayName })
          .pipe(Effect.catchTag("TeamRecordNotFound", (error) => Effect.die(error)));
        const link = yield* records
          .link({
            connectionId: connection.id,
            kind: "Group",
            resourceId: team.id,
            externalId: Option.getOrUndefined(externalId),
          })
          .pipe(
            Effect.catchTag("ScimLinkConflict", () =>
              teams
                .removeTeam(connection.organizationId, team.id)
                .pipe(
                  Effect.catch(() => Effect.void),
                  Effect.andThen(Effect.fail(ScimApi.conflict("externalId is already provisioned"))),
                ),
            ),
          );
        yield* Effect.forEach(memberIds, (userId) => addToTeam(team.id, userId), { discard: true });
        yield* events.publish({
          _tag: "auth.scim.groupChanged",
          connectionId: connection.id,
          organizationId: connection.organizationId,
          teamId: team.id,
          change: "created",
        });
        const fresh = yield* teams.findTeamById(connection.organizationId, team.id);
        return yield* groupResource(connection, {
          link,
          team: Option.getOrElse(fresh, () => team),
        });
      });

      const getGroup: ScimShape["getGroup"] = (connection, id) =>
        ownedGroup(connection, id).pipe(Effect.flatMap((owned) => groupResource(connection, owned)));

      const groupChanged = (connection: Connection, teamId: string, change: "updated" | "deleted") =>
        events.publish({
          _tag: "auth.scim.groupChanged",
          connectionId: connection.id,
          organizationId: connection.organizationId,
          teamId,
          change,
        });

      const renameGroup = (connection: Connection, team: TeamRecords.TeamRecord, displayName: string) =>
        displayName === team.name
          ? Effect.succeed(team)
          : teams
              .updateTeam(connection.organizationId, team.id, displayName)
              .pipe(Effect.catchTag("TeamRecordNotFound", () => Effect.fail(ScimApi.notFound())));

      const replaceGroup: ScimShape["replaceGroup"] = Effect.fnUntraced(function* (connection, id, input) {
        const owned = yield* ownedGroup(connection, id);
        const displayName = input.displayName.trim();
        if (displayName === "" || displayName.length > 255) {
          return yield* ScimApi.badRequest("displayName is required (at most 255 characters)");
        }
        const memberIds = (input.members ?? []).map((member) => member.value);
        yield* requireMembers(connection, memberIds);
        const link = yield* records
          .setExternalId(connection.id, "Group", id, Option.getOrNull(stringOf(input.externalId)))
          .pipe(
            Effect.catchTags({
              ScimLinkConflict: () => Effect.fail(ScimApi.conflict("externalId is already provisioned")),
              ScimRecordNotFound: () => Effect.fail(ScimApi.notFound()),
            }),
          );
        const team = yield* renameGroup(connection, owned.team, displayName);
        yield* replaceProvisioned(connection, id, memberIds);
        yield* groupChanged(connection, id, "updated");
        return yield* groupResource(connection, { link, team });
      });

      /** Member ids named by a PATCH operation's `value` (`[{ value }]`, `{ value }`) or by a `members[value eq "id"]` path. */
      const memberIdsOf = (operation: { readonly path?: string | undefined; readonly value?: unknown }): ReadonlyArray<string> => {
        const fromPath = /members\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(operation.path ?? "")?.[1];
        if (fromPath !== undefined) return [fromPath];
        const values = Array.isArray(operation.value) ? operation.value : [operation.value];
        return values.flatMap((entry) =>
          isRecord(entry) && typeof entry["value"] === "string" ? [entry["value"]] : [],
        );
      };

      const patchGroup: ScimShape["patchGroup"] = Effect.fnUntraced(function* (connection, id, patch) {
        const owned = yield* ownedGroup(connection, id);
        let team = owned.team;
        let link = owned.link;
        for (const operation of patch.Operations) {
          const op = operation.op.trim().toLowerCase();
          if (op !== "add" && op !== "replace" && op !== "remove") {
            return yield* ScimApi.badRequest(`Unknown patch op "${operation.op}"`, "invalidSyntax");
          }
          const path = (operation.path ?? "").trim();
          const attribute = path.toLowerCase();
          if (attribute === "displayname" || (path === "" && isRecord(operation.value) && "displayName" in operation.value)) {
            const name = stringOf(isRecord(operation.value) && path === "" ? operation.value["displayName"] : operation.value);
            if (Option.isNone(name) || op === "remove") {
              return yield* ScimApi.badRequest("displayName cannot be empty");
            }
            team = yield* renameGroup(connection, team, name.value);
          } else if (attribute === "externalid") {
            link = yield* records
              .setExternalId(connection.id, "Group", id, op === "remove" ? null : Option.getOrNull(stringOf(operation.value)))
              .pipe(
                Effect.catchTags({
                  ScimLinkConflict: () => Effect.fail(ScimApi.conflict("externalId is already provisioned")),
                  ScimRecordNotFound: () => Effect.fail(ScimApi.notFound()),
                }),
              );
          } else if (attribute.startsWith("members") || (path === "" && isRecord(operation.value) && "members" in operation.value)) {
            const target =
              path === "" && isRecord(operation.value)
                ? { path: "members", value: operation.value["members"] }
                : { path, value: operation.value };
            const ids = memberIdsOf(target);
            if (op === "replace" && !/members\[/i.test(path)) {
              yield* requireMembers(connection, ids);
              yield* replaceProvisioned(connection, id, ids);
            } else if (op === "add") {
              yield* requireMembers(connection, ids);
              yield* Effect.forEach(ids, (userId) => addToTeam(id, userId), { discard: true });
            } else if (op === "remove") {
              // `remove` with no value and a bare `members` path clears the provisioned members.
              const provisioned = yield* provisionedMembers(connection, id);
              const toRemove = ids.length === 0 && !/members\[/i.test(path) ? provisioned : ids.filter((userId) => provisioned.includes(userId));
              yield* Effect.forEach(toRemove, (userId) => removeFromTeam(id, userId), { discard: true });
            }
          }
        }
        yield* groupChanged(connection, id, "updated");
        return yield* groupResource(connection, { link, team });
      });

      const deleteGroup: ScimShape["deleteGroup"] = Effect.fnUntraced(function* (connection, id) {
        yield* ownedGroup(connection, id);
        yield* teams.removeTeam(connection.organizationId, id).pipe(
          Effect.catchTags({
            TeamRecordNotFound: () => Effect.void,
            TeamHasChildren: () =>
              Effect.fail(ScimApi.conflict("The group still has child teams; remove or move them first")),
          }),
        );
        // No session may keep a removed team active (CWM-003/OHS-007).
        yield* activeContext.clearTeam(id);
        yield* records.unlink(connection.id, "Group", id);
        yield* groupChanged(connection, id, "deleted");
      });

      return Scim.of({
        listUsers,
        createUser,
        getUser,
        replaceUser,
        patchUser,
        deleteUser,
        listGroups,
        createGroup,
        getGroup,
        replaceGroup,
        patchGroup,
        deleteGroup,
      });
    }),
  });
}

// ---- discovery documents -----------------------------------------------------------------------

const serviceProviderConfig: typeof ScimApi.ServiceProviderConfig.Type = {
  schemas: [ScimApi.SERVICE_PROVIDER_CONFIG_SCHEMA],
  patch: { supported: true },
  bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
  filter: { supported: true, maxResults: 200 },
  changePassword: { supported: false },
  sort: { supported: false },
  etag: { supported: false },
  authenticationSchemes: [
    {
      type: "oauthbearertoken",
      name: "Bearer token",
      description: "A long-lived bearer token issued for this connection.",
      primary: true,
    },
  ],
};

const resourceTypes: ReadonlyArray<typeof ScimApi.ResourceTypeDescription.Type> = [
  {
    schemas: [ScimApi.RESOURCE_TYPE_SCHEMA],
    id: "User",
    name: "User",
    endpoint: "/Users",
    schema: ScimApi.USER_SCHEMA,
  },
  {
    schemas: [ScimApi.RESOURCE_TYPE_SCHEMA],
    id: "Group",
    name: "Group",
    endpoint: "/Groups",
    schema: ScimApi.GROUP_SCHEMA,
  },
];

const schemaDescriptions: ReadonlyArray<typeof ScimApi.SchemaDescription.Type> = [
  {
    schemas: [ScimApi.SCHEMA_SCHEMA],
    id: ScimApi.USER_SCHEMA,
    name: "User",
    description: "A user this connection provisioned: userName (immutable), name, displayName, emails, active, externalId.",
  },
  {
    schemas: [ScimApi.SCHEMA_SCHEMA],
    id: ScimApi.GROUP_SCHEMA,
    name: "Group",
    description: "An organization team: displayName, members (the users this connection provisioned), externalId.",
  },
];
