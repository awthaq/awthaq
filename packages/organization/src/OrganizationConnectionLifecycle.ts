// @awthaq/organization — OrganizationConnectionLifecycle
//
// CONN-01..04, BEH-EA-317/318/237/235. The one exposed service (ADR-EA-040) that owns what it means for an
// organization to hold an SSO connection, whatever protocol routes it (OIDC today, SAML next): the
// suspended-organization gate, the claim of the connection's email domains and the connection write as one unit,
// the compensation, the claims-first removal, the single domain normaliser, and the release of every claim when
// the organization is deleted. A protocol supplies a `ConnectionProtocol` descriptor (its stored name and its own
// refusal and taken-domain errors) and a `prepare` of its own (validation, id, and the row write as an effect);
// the sequence exists here once, so two protocols cannot drift apart.
//
// Events stay with the protocol and fire after this returns (ADR-EA-049): the module publishes nothing, so a
// rolled-back claim never leaves an audit row.
//
// Three deliberate departures from the sequence the stores ran before this phase:
//   - the compensation runs INSIDE the transaction effect: the memory twin (no real transaction) gives the
//     claim back there, and a real transaction rolls it back with everything else, so a rolled-back update can
//     no longer re-claim, after the rollback, for a connection a concurrent removal had deleted;
//   - claims come first everywhere (remove releases its claims before the caller's row removal), so the
//     per-organization lock in DomainClaims orders every writer and the update-versus-remove deadlock is gone;
//   - create re-reads the organization under that lock right after the claim, so a create that passed the gate
//     cannot commit a connection or a claim for an organization whose deletion committed meanwhile.
// Update and remove need no re-check: their row write fails NotFound and rolls the unit back.
//
// The transaction is the `SqlTransaction` port taken as a service (CONN-04); no protocol type is imported here.

import { SqlTransaction } from "@awthaq/ports";
import { StoreFailure } from "@awthaq/sql";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DomainClaims from "./DomainClaims.ts";
import * as OrganizationDeletion from "./OrganizationDeletion.ts";
import * as OrganizationDirectory from "./OrganizationDirectory.ts";

/** What a protocol tells the lifecycle about itself. */
export interface ConnectionProtocol<Refused, Taken> {
  /** The value claim rows store: `"oauth"` (OIDC and OAuth2), `"saml"`. */
  readonly protocol: string;
  /** The protocol's own refusal, worded `reason`. */
  readonly refuse: (reason: string) => Refused;
  /** The protocol's own error for a domain another organization owns. */
  readonly taken: (domain: string) => Taken;
}

/** A create the protocol has validated: its id, its normalised domains and the row write. */
export interface Prepared<A, E, R> {
  readonly connectionId: string;
  readonly domains: ReadonlyArray<string>;
  readonly write: Effect.Effect<A, E, R>;
}

/** An update the protocol has validated. `domains` is `undefined` when the update names none: no claim, no transaction. */
export interface PreparedUpdate<A, E, R> {
  readonly connectionId: string;
  readonly domains: ReadonlyArray<string> | undefined;
  /** The domains the connection claimed before this update (restored when the unit fails). */
  readonly previous: ReadonlyArray<string>;
  readonly write: Effect.Effect<A, E, R>;
}

const GONE = "the organization does not exist";

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** Trims, lower-cases and de-duplicates (first-seen order); an invalid domain is the protocol's own refusal. */
export const normalizeDomains = <Refused, Taken>(
  protocol: ConnectionProtocol<Refused, Taken>,
  domains: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<string>, Refused> => {
  const normalized = Array.from(new Set(domains.map((domain) => domain.trim().toLowerCase())));
  const bad = normalized.find((domain) => !DOMAIN.test(domain));
  return bad === undefined
    ? Effect.succeed(normalized)
    : Effect.fail(protocol.refuse(`"${bad}" is not a valid email domain`));
};

export interface OrganizationConnectionLifecycleShape {
  /**
   * A connection belongs to an active organization: gate, `prepare`, then claim, re-check and write as one unit.
   * A missing and a suspended organization are refused alike (`protocol.refuse`), before `prepare` runs.
   */
  readonly create: <Refused, Taken, A, E, R, EP, RP>(
    protocol: ConnectionProtocol<Refused, Taken>,
    organizationId: string,
    prepare: Effect.Effect<Prepared<A, E, R>, EP, RP>,
  ) => Effect.Effect<A, Refused | Taken | E | EP | StoreFailure.StoreUnavailable, R | RP>;
  /** The same gate, then claim and write as one unit when the update names domains; the write alone otherwise. */
  readonly update: <Refused, Taken, A, E, R, EP, RP>(
    protocol: ConnectionProtocol<Refused, Taken>,
    organizationId: string,
    prepare: Effect.Effect<PreparedUpdate<A, E, R>, EP, RP>,
  ) => Effect.Effect<A, Refused | Taken | E | EP | StoreFailure.StoreUnavailable, R | RP>;
  /** No gate: a suspended organization's connection can be removed. Releases the claims, then runs `write`, as one unit. */
  readonly remove: <A, E, R>(
    protocol: ConnectionProtocol<unknown, unknown>,
    organizationId: string,
    connectionId: string,
    previous: ReadonlyArray<string>,
    write: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | StoreFailure.StoreUnavailable, R>;
}

export class OrganizationConnectionLifecycle extends Context.Service<
  OrganizationConnectionLifecycle,
  OrganizationConnectionLifecycleShape
>()("awthaq/plugin/organization/ConnectionLifecycle") {
  static readonly layer = Layer.effect(
    OrganizationConnectionLifecycle,
    Effect.gen(function* () {
      const claims = yield* DomainClaims.DomainClaims;
      const directory = yield* OrganizationDirectory.OrganizationDirectory;
      const transaction = yield* SqlTransaction.SqlTransaction;

      /** `Some` when the organization exists and is not suspended; both other cases are one refusal. */
      const requireActive = <Refused, Taken>(
        protocol: ConnectionProtocol<Refused, Taken>,
        organizationId: string,
      ) =>
        directory.findActive(organizationId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(protocol.refuse(GONE)),
              onSome: () => Effect.void,
            }),
          ),
        );

      /** The domain claim, a taken domain worded as the protocol's own error. */
      const claim = <Refused, Taken>(
        protocol: ConnectionProtocol<Refused, Taken>,
        organizationId: string,
        connectionId: string,
        domains: ReadonlyArray<string>,
      ) =>
        claims
          .claim({ organizationId, protocol: protocol.protocol, connectionId, domains })
          .pipe(
            Effect.mapError((error) =>
              error instanceof DomainClaims.DomainClaimTaken ? protocol.taken(error.domain) : error,
            ),
          );

      /** The compensation of a failed update or remove: the connection's previous claim, as it was. */
      const reclaim = (
        protocol: ConnectionProtocol<unknown, unknown>,
        organizationId: string,
        connectionId: string,
        previous: ReadonlyArray<string>,
      ) =>
        claims.claim({
          organizationId,
          protocol: protocol.protocol,
          connectionId,
          domains: previous,
        });

      /**
       * `body` in one transaction. `compensate` runs inside it when `body` fails (the memory twin gives the claim
       * back there; a real transaction rolls it back too).
       */
      const unit = <A, E, R>(
        label: string,
        body: Effect.Effect<A, E, R>,
        compensate: Effect.Effect<
          void,
          DomainClaims.DomainClaimTaken | StoreFailure.StoreUnavailable
        >,
      ) =>
        transaction
          .withTransaction(body.pipe(Effect.onError(() => Effect.ignore(compensate))))
          .pipe(Effect.catchTag("SqlError", StoreFailure.storeUnavailable(label)));

      const create: OrganizationConnectionLifecycleShape["create"] = (
        protocol,
        organizationId,
        prepare,
      ) =>
        Effect.gen(function* () {
          yield* requireActive(protocol, organizationId);
          const { connectionId, domains, write } = yield* prepare;
          return yield* unit(
            "OrganizationConnectionLifecycle.create",
            Effect.gen(function* () {
              yield* claim(protocol, organizationId, connectionId, domains);
              // Under the organization lock the claim took: a deletion that committed meanwhile is seen here.
              yield* requireActive(protocol, organizationId);
              return yield* write;
            }),
            claims.release(organizationId, connectionId),
          );
        });

      const update: OrganizationConnectionLifecycleShape["update"] = (
        protocol,
        organizationId,
        prepare,
      ) =>
        Effect.gen(function* () {
          yield* requireActive(protocol, organizationId);
          const { connectionId, domains, previous, write } = yield* prepare;
          return yield* domains === undefined
            ? write
            : unit(
                "OrganizationConnectionLifecycle.update",
                Effect.andThen(claim(protocol, organizationId, connectionId, domains), write),
                reclaim(protocol, organizationId, connectionId, previous),
              );
        });

      const remove: OrganizationConnectionLifecycleShape["remove"] = (
        protocol,
        organizationId,
        connectionId,
        previous,
        write,
      ) =>
        unit(
          "OrganizationConnectionLifecycle.remove",
          Effect.andThen(claims.release(organizationId, connectionId), write),
          reclaim(protocol, organizationId, connectionId, previous),
        );

      return OrganizationConnectionLifecycle.of({ create, update, remove });
    }),
  );
}

/**
 * An organization's deletion releases every claim it holds, first and inside the deletion's transaction,
 * whatever protocols are composed (CONN-01, T-04-09).
 */
export const claimsOnOrganizationDelete = OrganizationDeletion.contribute({
  id: "organization.domainClaims",
  order: -1,
  make: Effect.map(DomainClaims.DomainClaims, (claims) => ({
    inTransaction: claims.releaseAllForOrganization,
  })),
});
