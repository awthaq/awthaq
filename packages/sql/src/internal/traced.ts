// @awthaq/sql — the EOTS-008 span helper the SQL store adapters share (private to the package).

import * as Effect from "effect/Effect";

/**
 * EOTS-008: SqlModel names its own CRUD spans `<spanPrefix>.<method>`; every
 * hand-written method gets the same convention so a flame graph reads
 * `Users.findByEmail > sql.execute`. Attributes are ids only — never an
 * email, identifier, hash, token or payload (BEH-EA-199).
 */
export const traced = (name: string, attributes?: Record<string, unknown>) =>
  Effect.withSpan(name, attributes === undefined ? {} : { attributes }, {
    captureStackTrace: false,
  });
