// @awthaq/core — Phone
//
// SOS-008/FAMS-002 (wayfinder ticket 09's Phone identity): the one place a raw
// phone string becomes the `E164` value `Users` accepts. The type system
// carries the guarantee — `Users.create`/`promoteIdentity`/`findByPhone` take
// only the branded `E164`, so an un-normalized number cannot reach storage and
// three spellings of one number resolve to one stored value.
//
// Deliberately minimal (strip separators, resolve the international prefix or a
// configured default country code): it does not know national numbering plans,
// so it never claims a number is *dialable*, only that it is well-formed E.164.
// A host that needs full validation (libphonenumber-js) does it before calling
// `Users`; this is the floor, not a replacement.

import { Models as SqlModels } from "@awthaq/sql";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A well-formed E.164 number: `+`, then 2-15 digits, no leading zero. */
export type E164 = SqlModels.E164;
export const E164 = SqlModels.E164;

// The brand is minted by decoding (the shape check *is* the schema), never asserted.
const decode = Schema.decodeUnknownOption(SqlModels.E164);

export interface NormalizeOptions {
  /**
   * The calling code (digits only, no `+`; e.g. `"1"`, `"44"`) assumed for
   * input that has no `+`/`00` prefix. Without it such input is refused.
   */
  readonly defaultCountryCode?: string | undefined;
}

/**
 * `"+1 (555) 0100"`, `"1-555-0100"` (default country code `"1"`) and
 * `"+15550100"` all normalize to `+15550100`. Returns `None` for anything that
 * is not (after cleanup) a well-formed E.164 number.
 *
 * With a default country code, a leading trunk `0` is dropped (`020 7946 0958`
 * -> `+442079460958` under `"44"`) and digits that already start with the
 * country code are read as international.
 */
export const normalizePhone = (raw: string, options?: NormalizeOptions): Option.Option<E164> => {
  const trimmed = raw.trim();
  // Anything but digits, a leading `+` and the usual separators is not a phone number.
  if (!/^\+?[\d\s().-]+$/.test(trimmed)) return Option.none();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return decode(`+${digits}`);
  if (digits.startsWith("00")) return decode(`+${digits.slice(2)}`);
  const country = options?.defaultCountryCode;
  if (country === undefined || !/^[1-9]\d{0,2}$/.test(country)) return Option.none();
  if (digits.startsWith("0")) return decode(`+${country}${digits.slice(1)}`);
  if (digits.startsWith(country)) return decode(`+${digits}`);
  return decode(`+${country}${digits}`);
};
