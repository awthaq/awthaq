// @awthaq/organization — OrganizationMigrations
//
// The plugin's append-only migration ledger. Names and order are unchanged by the module split.

import { Migrations } from "@awthaq/core";
import { Defects } from "@awthaq/ports";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ---- migrations -------------------------------------------------------------------

/**
 * BAM-002 (.issues/high): no plugin populated `migrations` before AOMS-006's
 * cluster resolution added `@awthaq/jwt`'s own — this plugin's 7 tables are
 * the largest remaining gap the finding named. Ported verbatim from each
 * `*Records.test.ts`'s own inline `CREATE TABLE` (every table's canonical,
 * already-working shape — `OrganizationRecords.test.ts`,
 * `MembershipRecords.test.ts`, `InvitationRecords.test.ts`,
 * `TeamRecords.test.ts`, `ActiveContextRecords.test.ts`,
 * `OrgRoleRecords.test.ts`), dialect-branched via `sql.onDialectOrElse`
 * like `@awthaq/sql`'s own `CoreMigrations.ts`. Columns left unquoted under
 * `pg` (unlike `CoreMigrations.ts`'s own `users`/`sessions` tables, like
 * `@awthaq/jwt`'s own `jwtMigrations`): every one of this plugin's own
 * queries already references every column unquoted, so Postgres's
 * automatic lowercase-folding is what keeps migration and query consistent
 * here. `organization_role`'s `UNIQUE(organizationId, role)` and
 * `organization_org.slug UNIQUE` are ported as-is from their own test
 * fixtures. The first eleven migrations are exactly that DDL parity
 * (BAM-002's own ask, not a fresh constraint audit); everything after them
 * is an incremental, never-edited-after-shipping change — MTI-003/OHS-003's
 * `(userId, organizationId)` and `(teamId, userId)` UNIQUE indexes (each
 * collapsing pre-existing duplicates first) and the later column additions.
 * `organizationId`/`userId`/`teamId`/`email`/`inviterId` indexes mirror
 * `CoreMigrations.ts`'s own `accounts_user_id`/`sessions_user_id`
 * precedent: added only where a column is a real, independent filter key
 * in this plugin's own queries (grep for `WHERE <col> =` across
 * `*Records.ts`) and not already covered by a composite UNIQUE's leftmost
 * column (`organization_role`'s own `UNIQUE(organizationId, role)` already
 * serves `WHERE organizationId = ...` lookups, so it gets no separate
 * index; `organization_active_context`'s own `sessionId` primary key
 * likewise needs none).
 */
export const organizationMigrations: Migrations.Migrations = [
  {
    name: "create_organization_org",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_org (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            logo TEXT,
            metadata TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_org (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            slug TEXT NOT NULL UNIQUE,
            logo TEXT,
            metadata TEXT,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_membership",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_membership (
            id TEXT PRIMARY KEY,
            "userId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_membership_indexes",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership("userId")`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_membership_organization_id ON organization_membership("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_membership_user_id ON organization_membership("userId")`,
            ),
          ),
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_invitation",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_invitation (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            "inviterId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "teamId" TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "expiresAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_invitation (
            id TEXT PRIMARY KEY,
            email TEXT NOT NULL,
            "inviterId" TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "teamId" TEXT,
            role TEXT NOT NULL,
            status TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "expiresAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_invitation_indexes",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation("inviterId")`,
            ),
          ),
        sqlite: () =>
          sql`CREATE INDEX organization_invitation_organization_id ON organization_invitation("organizationId")`.pipe(
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_email ON organization_invitation(email)`,
            ),
            Effect.andThen(
              sql`CREATE INDEX organization_invitation_inviter_id ON organization_invitation("inviterId")`,
            ),
          ),
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_team",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_team (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "memberCount" INTEGER NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            "organizationId" TEXT NOT NULL,
            "memberCount" INTEGER NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_team_organization_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_team_organization_id ON organization_team("organizationId")`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_organization_id ON organization_team("organizationId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_team_membership",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            "teamId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_team_membership (
            id TEXT PRIMARY KEY,
            "teamId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "createdAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_team_membership_team_id_index",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () =>
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership("teamId")`,
        sqlite: () =>
          sql`CREATE INDEX organization_team_membership_team_id ON organization_team_membership("teamId")`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_role",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_role (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL,
            UNIQUE("organizationId", role)
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_role (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            role TEXT NOT NULL,
            permission TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL,
            UNIQUE("organizationId", role)
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  {
    name: "create_organization_active_context",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_active_context (
            "sessionId" TEXT PRIMARY KEY,
            "activeOrganizationId" TEXT,
            "activeTeamId" TEXT,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_active_context (
            "sessionId" TEXT PRIMARY KEY,
            "activeOrganizationId" TEXT,
            "activeTeamId" TEXT,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
  // MTI-003: one membership per (user, organization). The statements are plain
  // SQL both dialects share, so no `onDialectOrElse`. Duplicates that already
  // exist are collapsed first (keeping the earliest row — uuidv7 ids sort by
  // creation time) so the index can be created on live data.
  {
    name: "organization_membership_unique_user_org",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM organization_membership WHERE id NOT IN (SELECT MIN(id) FROM organization_membership GROUP BY "userId", "organizationId")`;
      yield* sql`CREATE UNIQUE INDEX organization_membership_user_org ON organization_membership("userId", "organizationId")`;
    }),
  },
  // DRS-008: the active-context row is keyed by session but must be findable by
  // user (erasure, membership revocation). Nullable: rows that predate it stay
  // valid and are re-validated on read.
  {
    name: "organization_active_context_user_id",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_active_context ADD COLUMN "userId" TEXT`;
      yield* sql`CREATE INDEX organization_active_context_user_id ON organization_active_context("userId")`;
    }),
  },
  // MTI-010: the emailed invitation capability is a random token, stored only as
  // its SHA-256; the invitation's own id is no longer the secret. Nullable so
  // rows written before this column stay readable (they cannot be accepted).
  {
    name: "organization_invitation_token_hash",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_invitation ADD COLUMN "tokenHash" TEXT`;
      yield* sql`CREATE UNIQUE INDEX organization_invitation_token_hash ON organization_invitation("tokenHash")`;
    }),
  },
  // OHS-003: one membership per (team, user), and `memberCount` recomputed from
  // the surviving rows so a previously over-counted team is repaired.
  {
    name: "organization_team_membership_unique_team_user",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM organization_team_membership WHERE id NOT IN (SELECT MIN(id) FROM organization_team_membership GROUP BY "teamId", "userId")`;
      yield* sql`UPDATE organization_team SET "memberCount" = (SELECT COUNT(*) FROM organization_team_membership WHERE organization_team_membership."teamId" = organization_team.id)`;
      yield* sql`CREATE UNIQUE INDEX organization_team_membership_team_user ON organization_team_membership("teamId", "userId")`;
    }),
  },
  // OHS-004: a team membership carries team-scoped role names (JSON array, like
  // `organization_membership.role`); every existing row is a plain `member`.
  {
    name: "organization_team_membership_role",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_team_membership ADD COLUMN role TEXT NOT NULL DEFAULT '["member"]'`;
    }),
  },
  // OHS-001 (wayfinder ticket 34): a team may sit under one parent. `parentId` is
  // the write-side adjacency; `organization_team_closure` is the read model — one
  // row per (ancestor, descendant) pair, self rows at depth 0 — so ancestors and
  // descendants are single indexed lookups on both dialects with no recursive CTE.
  // No foreign keys, like every other table here: TeamRecords maintains both in
  // one transaction. Every existing team gets its self row.
  {
    name: "organization_team_hierarchy",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_team ADD COLUMN "parentId" TEXT`;
      yield* sql`CREATE INDEX organization_team_parent_id ON organization_team("parentId")`;
      yield* sql`
        CREATE TABLE organization_team_closure (
          "ancestorId" TEXT NOT NULL,
          "descendantId" TEXT NOT NULL,
          depth INTEGER NOT NULL,
          PRIMARY KEY ("ancestorId", "descendantId")
        )`;
      yield* sql`CREATE INDEX organization_team_closure_descendant_id ON organization_team_closure("descendantId")`;
      yield* sql`INSERT INTO organization_team_closure ("ancestorId", "descendantId", depth) SELECT id, id, 0 FROM organization_team`;
    }),
  },
  // DRS-007: the residency region, from `OrganizationConfig.regions`. Nullable
  // — every existing organization simply has none.
  {
    name: "organization_org_home_region",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`ALTER TABLE organization_org ADD COLUMN "homeRegion" TEXT`;
    }),
  },
  // EP-004 (ADR-EA-018): an organization's own OIDC/OAuth2 identity provider. No
  // foreign keys, like every table here; the client secret is an `Encryption`
  // envelope. Email domains get their own table so a domain routes to exactly one
  // connection across all organizations (`domain` is `UNIQUE`, not the primary key:
  // SQLite reports a primary-key clash as a generic constraint error, not a unique violation).
  {
    name: "organization_oauth_connection",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`
          CREATE TABLE organization_oauth_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            issuer TEXT,
            "discoveryUrl" TEXT,
            "authorizationEndpoint" TEXT,
            "tokenEndpoint" TEXT,
            "jwksUri" TEXT,
            "userinfoEndpoint" TEXT,
            "clientId" TEXT NOT NULL,
            "clientSecret" TEXT,
            scopes TEXT NOT NULL,
            "createdAt" TIMESTAMPTZ NOT NULL,
            "updatedAt" TIMESTAMPTZ NOT NULL
          )`,
        sqlite: () => sql`
          CREATE TABLE organization_oauth_connection (
            id TEXT PRIMARY KEY,
            "organizationId" TEXT NOT NULL,
            kind TEXT NOT NULL,
            name TEXT NOT NULL,
            issuer TEXT,
            "discoveryUrl" TEXT,
            "authorizationEndpoint" TEXT,
            "tokenEndpoint" TEXT,
            "jwksUri" TEXT,
            "userinfoEndpoint" TEXT,
            "clientId" TEXT NOT NULL,
            "clientSecret" TEXT,
            scopes TEXT NOT NULL,
            "createdAt" TEXT NOT NULL,
            "updatedAt" TEXT NOT NULL
          )`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
      yield* sql`CREATE INDEX organization_oauth_connection_organization_id ON organization_oauth_connection("organizationId")`;
      yield* sql`
        CREATE TABLE organization_oauth_connection_domain (
          domain TEXT NOT NULL UNIQUE,
          "connectionId" TEXT NOT NULL,
          "organizationId" TEXT NOT NULL
        )`;
      yield* sql`CREATE INDEX organization_oauth_connection_domain_connection_id ON organization_oauth_connection_domain("connectionId")`;
    }),
  },
  // EP-003: platform suspension. `NULL` = active; a timestamp = suspended since.
  {
    name: "organization_org_suspended_at",
    up: Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.onDialectOrElse({
        pg: () => sql`ALTER TABLE organization_org ADD COLUMN "suspendedAt" TIMESTAMPTZ`,
        sqlite: () => sql`ALTER TABLE organization_org ADD COLUMN "suspendedAt" TEXT`,
        orElse: () => Defects.unsupportedDialect("migrations"),
      });
    }),
  },
];
