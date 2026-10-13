// @awthaq/organization — invitation token helpers (package-private)

// ---- invitation token helpers ---------------------------------------------------

export const hexOf = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/**
 * What a presented token's hash is compared against when no invitation (or no
 * stored hash) exists, so a miss does the same hash + compare work as a wrong
 * token for a real invitation. Never equals a real SHA-256 hex digest.
 */
export const NO_INVITATION_TOKEN_HASH = "0".repeat(64);
