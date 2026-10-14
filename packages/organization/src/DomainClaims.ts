// @awthaq/organization — DomainClaims
//
// Plan 10 item 7 (BEH-EA-317): one email domain belongs to one organization, whatever protocol routes it.
// `organization_oauth_connection_domain` (OIDC/OAuth2) and `saml_connection_domain` (SAML) are each unique
// only within themselves, so organization B could claim `acme.com` over SAML while the real Acme routes it
// over OIDC, and `Sso.discover` (default `preferred: "saml"`) would send every `@acme.com` sign-in to B's IdP.
// This store is the one place a connection's domains are claimed. The rule:
//
//   - a domain has at most one *owner organization*; another organization claiming it is `DomainClaimTaken`;
//   - the owner may route it over both protocols, and over several connections (`Sso.preferred` picks);
//   - a claim lives and dies with its connection (`release`), and with its organization.
//
// Domains are still asserted, not verified (no DNS proof); this is the place a `verifiedAt` column would go.
//
// Two tables: `organization_domain_claim` (one row per connection and domain, so a release knows what is
// left) and `organization_domain_owner` (one row per domain). The owner table's primary key is what makes a
// first claim atomic on every database: two organizations racing for the same unclaimed domain cannot both
// insert its owner row. The per-protocol tables keep their own uniqueness as defence in depth.
//
// Every statement reads across organizations by nature (that is the rule), so the module presents one
// `CrossTenant` witness for the claim read; the writes are keyed by the claiming organization.
// A claim is written inside the caller's transaction (`SqlTransaction`) beside the connection row: a refused
// claim rolls the connection write back. The memory twin is atomic per `Ref`; the caller there releases on a
// failed write.

import { StoreFailure, TenantScoped } from "@awthaq/sql";
import { SqlTransaction } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

/** Another organization already owns this email domain. */
export class DomainClaimTaken extends Data.TaggedError("DomainClaimTaken")<{
  readonly domain: string;
}> {}

export interface DomainClaim {
  readonly organizationId: string;
  /** Which protocol routes the domain: `"oauth"` (OIDC and OAuth2 connections) or `"saml"`. A plugin adding another names its own. */
  readonly protocol: string;
  readonly connectionId: string;
  /** Normalised (lower-case) domains; the connection's whole set. */
  readonly domains: ReadonlyArray<string>;
}

export interface DomainClaimsShape {
  /**
   * Sets the domains `connectionId` claims for its organization (the whole set: a domain it no longer names is
   * released). Fails with `DomainClaimTaken` for the first domain another organization owns; nothing changes then.
   */
  readonly claim: (
    input: DomainClaim,
  ) => Effect.Effect<void, DomainClaimTaken | StoreFailure.StoreUnavailable>;
  /** Releases everything one connection claimed (its deletion). Idempotent. */
  readonly release: (
    organizationId: string,
    connectionId: string,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
  /** Releases everything an organization claimed (its deletion). Idempotent. */
  readonly releaseAllForOrganization: (
    organizationId: string,
  ) => Effect.Effect<void, StoreFailure.StoreUnavailable>;
}

export class DomainClaims extends Context.Service<DomainClaims, DomainClaimsShape>()(
  "awthaq/organization/records/DomainClaims",
) {}

const taken = (domain: string): DomainClaimTaken => new DomainClaimTaken({ domain });

/** The one cross-organization read this module makes (the owner row of the domain being claimed). */
const claimGrant = TenantScoped.crossTenant(
  "domain claims: a domain has one owner organization, so the claim check reads every organization's owner row",
);

// ---- layerMemory ------------------------------------------------------------

interface StoredClaim {
  readonly organizationId: string;
  readonly protocol: string;
  readonly connectionId: string;
  readonly domain: string;
}

export const layerMemory = Layer.effect(
  DomainClaims,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<StoredClaim>>([]);

    const claim: DomainClaimsShape["claim"] = (input) =>
      Ref.modify(
        state,
        (rows): readonly [Result.Result<void, DomainClaimTaken>, ReadonlyArray<StoredClaim>] => {
          const foreign = input.domains.find((domain) =>
            rows.some(
              (row) => row.domain === domain && row.organizationId !== input.organizationId,
            ),
          );
          if (foreign !== undefined) return [Result.fail(taken(foreign)), rows] as const;
          const kept = rows.filter(
            (row) =>
              !(
                row.connectionId === input.connectionId &&
                row.organizationId === input.organizationId
              ),
          );
          const added = input.domains.map((domain): StoredClaim => ({
            organizationId: input.organizationId,
            protocol: input.protocol,
            connectionId: input.connectionId,
            domain,
          }));
          return [Result.succeed(undefined), [...kept, ...added]] as const;
        },
      ).pipe(Effect.flatMap(Effect.fromResult));

    const release: DomainClaimsShape["release"] = (organizationId, connectionId) =>
      Ref.update(state, (rows) =>
        rows.filter(
          (row) => !(row.connectionId === connectionId && row.organizationId === organizationId),
        ),
      );

    const releaseAllForOrganization: DomainClaimsShape["releaseAllForOrganization"] = (
      organizationId,
    ) => Ref.update(state, (rows) => rows.filter((row) => row.organizationId !== organizationId));

    return { claim, release, releaseAllForOrganization };
  }),
);

// ---- layerSql -----------------------------------------------------------------

export const layerSql = Layer.effect(
  DomainClaims,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const unavailable = (operation: string) =>
      StoreFailure.orStoreUnavailable(`DomainClaims.${operation}`);

    const ownerOf = SqlSchema.findOneOption({
      Request: Schema.String,
      Result: Schema.Struct({ organizationId: Schema.String }),
      execute: (domain) =>
        sql`SELECT "organizationId" FROM organization_domain_owner WHERE domain = ${domain}`,
    });

    /** An organization's owner rows that no claim backs any more. */
    const dropOrphanOwners = (organizationId: string) =>
      sql`DELETE FROM organization_domain_owner WHERE "organizationId" = ${organizationId} AND NOT EXISTS (SELECT 1 FROM organization_domain_claim c WHERE c.domain = organization_domain_owner.domain)`;

    const claim: DomainClaimsShape["claim"] = (input) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          for (const domain of input.domains) {
            // The primary key decides a race: the loser's insert is skipped and the read names the winner.
            yield* sql`INSERT INTO organization_domain_owner (domain, "organizationId") VALUES (${domain}, ${input.organizationId}) ON CONFLICT (domain) DO NOTHING`;
            // Only this read crosses organizations; the writes stay confined by the row-level policy.
            const owner = yield* ownerOf(domain).pipe(TenantScoped.liftOn(sql, claimGrant));
            if (Option.isNone(owner) || owner.value.organizationId !== input.organizationId) {
              return yield* Effect.fail(taken(domain));
            }
          }
          yield* sql`DELETE FROM organization_domain_claim WHERE "connectionId" = ${input.connectionId} AND "organizationId" = ${input.organizationId}`;
          for (const domain of input.domains) {
            yield* sql`INSERT INTO organization_domain_claim (domain, "connectionId", protocol, "organizationId") VALUES (${domain}, ${input.connectionId}, ${input.protocol}, ${input.organizationId})`;
          }
          yield* dropOrphanOwners(input.organizationId);
        }),
      ).pipe(unavailable("claim"));

    const release: DomainClaimsShape["release"] = (organizationId, connectionId) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          yield* sql`DELETE FROM organization_domain_claim WHERE "connectionId" = ${connectionId} AND "organizationId" = ${organizationId}`;
          yield* dropOrphanOwners(organizationId);
        }),
      ).pipe(unavailable("release"));

    const releaseAllForOrganization: DomainClaimsShape["releaseAllForOrganization"] = (
      organizationId,
    ) =>
      SqlTransaction.transactional(sql)(
        Effect.gen(function* () {
          yield* sql`DELETE FROM organization_domain_claim WHERE "organizationId" = ${organizationId}`;
          yield* sql`DELETE FROM organization_domain_owner WHERE "organizationId" = ${organizationId}`;
        }),
      ).pipe(unavailable("releaseAllForOrganization"));

    return { claim, release, releaseAllForOrganization };
  }),
);

// ---- the write seam ------------------------------------------------------------

/**
 * Runs `write` (the connection's own row) and claims `input.domains` as one unit: inside the caller's
 * `SqlTransaction` a refused claim, or a failed write, rolls both back. Where the transaction is a no-op
 * (the memory twin) a failed write releases the claim again, or restores `previous` (the domains the
 * connection claimed before this update; `undefined` for a creation). The claim comes first so a taken
 * domain is refused before anything is written. A taken domain is `onTaken`'s value: the caller's own protocol error.
 */
export const withClaim = <A, E, R, Taken>(
  claims: DomainClaimsShape,
  transaction: SqlTransaction.SqlTransactionShape,
  input: DomainClaim,
  previous: ReadonlyArray<string> | undefined,
  write: Effect.Effect<A, E, R>,
  onTaken: (domain: string) => Taken,
) =>
  transaction.withTransaction(Effect.andThen(claims.claim(input), write)).pipe(
    Effect.onError(() =>
      (previous === undefined
        ? claims.release(input.organizationId, input.connectionId)
        : claims.claim({ ...input, domains: previous })
      ).pipe(Effect.ignore),
    ),
    Effect.mapError((error) => (error instanceof DomainClaimTaken ? onTaken(error.domain) : error)),
    Effect.catchTag("SqlError", StoreFailure.storeUnavailable("DomainClaims.withClaim")),
  );

/** Deletes a connection and releases its claim as one unit (the same transaction rule as `withClaim`). */
export const withRelease = <A, E, R>(
  claims: DomainClaimsShape,
  transaction: SqlTransaction.SqlTransactionShape,
  organizationId: string,
  connectionId: string,
  remove: Effect.Effect<A, E, R>,
) =>
  transaction
    .withTransaction(Effect.andThen(remove, claims.release(organizationId, connectionId)))
    .pipe(Effect.catchTag("SqlError", StoreFailure.storeUnavailable("DomainClaims.withRelease")));
