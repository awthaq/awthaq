// @awthaq/api — Email
//
// BEH-EA-085 (schema-decoded payloads), ESS-006. One shared, isomorphic
// definition of "looks like an email address" for every payload that carries
// one (password sign-up/sign-in/reset/resend today; magic-link, email-otp and
// organization invitations next), so malformed input is rejected at decode
// (400) before any rate-limit bucket, hasher or database is touched, and the
// browser client can validate with the same schema.
//
// Deliberately a *shape* check, not address validation: exactly one `@`, no
// whitespace, a non-empty local part (at most 64 characters) and a domain
// containing a dot (total at most 254, RFC 5321). It does not normalize — the
// value decodes exactly as sent — and it does not prove the mailbox exists;
// only the verification mail does that.

import * as Schema from "effect/Schema";

const MAX_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** `undefined` when `value` has the shape of an email address, otherwise why not. */
const problemWith = (value: string): string | undefined => {
  if (value.length > MAX_LENGTH) return `an email address of at most ${MAX_LENGTH} characters`;
  if (/\s/.test(value)) return "an email address without whitespace";
  const parts = value.split("@");
  const [local, domain] = parts;
  if (parts.length !== 2 || local === undefined || domain === undefined) {
    return "an email address with exactly one '@'";
  }
  if (local.length === 0 || local.length > MAX_LOCAL_LENGTH) {
    return `a local part of 1 to ${MAX_LOCAL_LENGTH} characters`;
  }
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return "a domain containing a dot, not at either end";
  }
  return undefined;
};

export const Email = Schema.String.pipe(Schema.check(Schema.makeFilter(problemWith)));
export type Email = typeof Email.Type;
