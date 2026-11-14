# Phase 4 Findings

## FINDING F-04-01: SCIM createConnection accepts an unknown organization

**Requirement:** CONN-06. **Disposition:** recorded only; the fix is CONN-F1, deferred by the phase CONTEXT.

**Where** (read at `c683a1bc`):

- `packages/scim/src/ScimConnections.ts`, `ScimConnectionStore.create` (lines 93-103): generates an id and a token, then calls `records.createConnection`; it never consults `OrganizationDirectory`.
- `packages/scim/src/ScimRecords.ts`, `createConnection` in the memory twin (lines 196-212) and in the SQL layer (lines 662-676): neither checks that the organization exists.
- `packages/scim/src/Scim.ts` (lines 512-536): the `scim_connection` table is created with no foreign key to the organization table.

**Impact:** a SCIM connection (and its bearer-token hash) is stored for an organization id that names no organization, and `list` returns it. The token cannot authenticate: `ScimAuthenticationLive` resolves the organization through `findActive` and answers 401, so this is not an authentication bypass. The row is never removed: `OrganizationDeletion` only runs for an organization that exists, so the SCIM deletion contribution never sees the orphan. It is a data-hygiene defect (orphan rows that outlive every cleanup path), not an exposure.

**Reproduction:** `npx vitest run packages/scim/test/ScimConnectionOrphan.test.ts`. The test creates a connection for `"no-such-organization"`, sees it stored and listed, and sees `OrganizationDirectory.findActive("no-such-organization")` is `None`. It passes against today's `src` and is expected to flip when CONN-F1 lands.

**Disposition:** not fixed in this phase. SCIM is out of scope for Phase 4 except the shared lifecycle gate it does not use and the deletion hook it already contributes; nothing under `packages/scim/src`, `packages/scim/package.json` or `packages/scim/README.md` changes. The only file added under `packages/scim` is the characterization test above (it pins this finding and changes no SCIM behaviour).

**Suggested fix (CONN-F1):** `ScimConnectionStore.create` gates on `OrganizationDirectory.findActive` and fails with an invalid-connection error naming "the organization does not exist", as the OIDC and SAML stores word it; then `ScimConnectionOrphan.test.ts` is rewritten as the refusal pin.

## Residuals

(Later plans append here: items the phase documents but does not fix.)
