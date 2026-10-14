// @awthaq/ports — Store
//
// Plan 02 (ADR-EA-041): what every core store port (`SessionStore`, `UserStore`, `AccountStore`,
// `VerificationStore`, `AuditLogStore`) shares. A store primitive is atomic by contract and fails
// only with the typed `StoreUnavailable`: an infrastructure failure (ADR-EA-028), never a defect a
// retry cannot fix. The class is `@awthaq/api`'s wire error (`Api.StoreUnavailable`, 503) on
// purpose, so it crosses the HTTP boundary as itself with no mapping layer.

import { Api } from "@awthaq/api";

export import StoreUnavailable = Api.StoreUnavailable;

/**
 * RRC-001/ADR-EA-024: how fresh a read must be. `"authoritative"` (the default) reads the primary;
 * `"eventual"` lets an adapter with a read replica serve a display-only listing from it. An adapter
 * with no replica concept ignores it. Never request `"eventual"` for a liveness or authorization
 * decision.
 */
export type Consistency = "authoritative" | "eventual";

/** The per-call read options a listing accepts. */
export interface ReadOptions {
  readonly consistency?: Consistency;
}
