// @awthaq/ports — ConstantTime
//
// BEH-EA-056/060, ACS-002. The one constant-time comparator secret material is
// checked with in this workspace: a session secret hash, a verification token
// digest, a KDF output. An ordinary `===`/`!==` on a secret digest returns at
// the first differing byte, and how early it did is timing an attacker can
// measure; these always inspect every byte.
//
// A length mismatch is not secret (a stored digest's length is public), so it
// returns early; a content difference never does.
//
// The one place a digest is still compared by ordinary equality is inside the
// database predicate of `VerificationRepository.tryConsume` (`WHERE valueHash
// = ...`), which a caller cannot time apart from the query it belongs to. That
// is an accepted exception: both sides are SHA-256 of a 256-bit random secret
// (BEH-EA-060), so a prefix match reveals nothing an attacker could use.

export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
};

/** The same for two equal-length hex (or any ASCII) digests held as strings. */
export const equalHex = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
};
