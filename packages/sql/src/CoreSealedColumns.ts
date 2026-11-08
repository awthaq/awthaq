// @awthaq/sql — CoreSealedColumns
//
// Plan 17 (ADR-EA-019 revision 1.3): core's six sealed columns, declared once like every plugin
// column. The SQL adapters build a `SealedColumn.codec` over each; `Persistence.sql(options)` provides
// `SealedColumn.Deployed` from `deployed(options)`, so `SealedColumn.sweepDeployed` reaches core rows
// and cannot sweep a column the composition stores in plaintext.
//
// The AADs are the substrate's one convention, `<table>:<rowKey>:<column>`: `users:<id>:metadata`,
// `sessions:<id>:ipAddress`, `sessions:<id>:userAgent` and `accounts:<id>:<field>`.

import * as SealedColumn from "./SealedColumn.ts";

/** CSG-006: sealed only when the composition opts in (`Persistence.sql({ encryptPii: true })`). */
export const usersMetadata = SealedColumn.column({
  table: "users",
  column: "metadata",
  key: "id",
  adoptPlaintext: true,
});

/** CSG-006: sealed only when the composition opts in; immutable after insert. */
export const sessionsIpAddress = SealedColumn.column({
  table: "sessions",
  column: "ipAddress",
  key: "id",
  adoptPlaintext: true,
});

/** CSG-006: sealed only when the composition opts in; immutable after insert. */
export const sessionsUserAgent = SealedColumn.column({
  table: "sessions",
  column: "userAgent",
  key: "id",
  adoptPlaintext: true,
});

// SMS-002: the provider tokens are always sealed. Each is bound to the account row (ticket 18: a
// ciphertext cannot be silently swapped between rows, or between the token columns of one row).
export const accountsAccessToken = SealedColumn.column({
  table: "accounts",
  column: "accessToken",
  key: "id",
});
export const accountsRefreshToken = SealedColumn.column({
  table: "accounts",
  column: "refreshToken",
  key: "id",
});
export const accountsIdToken = SealedColumn.column({
  table: "accounts",
  column: "idToken",
  key: "id",
});

/** The columns that are always sealed. */
export const providerTokens: ReadonlyArray<SealedColumn.Sweepable> = [
  accountsAccessToken,
  accountsRefreshToken,
  accountsIdToken,
];

/** The columns sealed only with `encryptPii`. */
export const personalData: ReadonlyArray<SealedColumn.Sweepable> = [
  usersMetadata,
  sessionsIpAddress,
  sessionsUserAgent,
];

/**
 * The columns a `Persistence.sql(options)` composition seals. Plaintext PII is never listed: sweeping it
 * would seal it behind a plaintext adapter.
 */
export const deployed = (options: {
  readonly encryptPii: boolean;
}): ReadonlyArray<SealedColumn.Sweepable> =>
  options.encryptPii ? [...providerTokens, ...personalData] : providerTokens;
