// @awthaq/core — ConstantTime
//
// TSS-003 (workstream `shared-constant-time-compare`): the one exported
// constant-time comparison, so secret material (correlation cookies, hashed
// tokens, MACs) is never compared with a short-circuiting `===`/`!==`. The
// private per-module copies (`Sessions.ts`, `Csrf.ts`, `ChallengeStore.ts`,
// `PasswordHasher.ts`) are being folded into this one by their owners'
// programs.

/**
 * Compares two byte strings without an early exit: a length difference is
 * folded into the accumulator instead of returning immediately, and the loop
 * always runs over the longer operand, so the running time depends only on
 * the longer length — never on where (or whether) the operands first differ.
 * Callers comparing secrets of attacker-chosen length should hash both sides
 * to a fixed length first, which removes even the length signal.
 */
export const constantTimeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

/** `constantTimeEqual` over the UTF-8 bytes of two strings. */
export const constantTimeEqualString = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  return constantTimeEqual(encoder.encode(a), encoder.encode(b));
};
