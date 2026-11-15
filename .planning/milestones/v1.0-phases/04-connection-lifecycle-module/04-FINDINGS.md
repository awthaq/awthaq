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

## FINDING F-04-02: the shared domain normaliser has no cap on domain count or length

**Requirement:** CONN-02 (the single normaliser). **Disposition:** recorded only; found by the phase code review (IN-04), deferred because a cap changes validation inside a behaviour-preserving refactor.

**Where** (read at `c683a1bc`, still true at the review-fix commit):

- `packages/organization/src/OrganizationConnectionLifecycle.ts`, `normalizeDomains`: trims, lower-cases, de-duplicates and tests each domain against `DOMAIN`. It has no limit on how many domains a connection names and no length rule (the regex accepts labels longer than 63 characters and names longer than 253).
- The 50-domain cap exists only in the SAML HTTP schema (`packages/saml/src/SamlApi.ts`, lines 248-253). OIDC has no HTTP surface and no cap, and an application that calls `SamlConnectionStore` or `OrganizationConnectionStore` directly bypasses the schema.
- `packages/organization/src/DomainClaims.ts`, `claim`: runs N owner inserts, N owner reads, one delete, N claim inserts and a drop-orphans statement, serially, under the per-organization advisory lock.

**Impact:** a non-HTTP caller can hand a connection a very large domain set (or over-long names). The unit then holds the organization's lock and one transaction for 3N statements, which stalls every other claim, release and deletion of that organization for as long as it runs. Not an exposure of data and not reachable from the HTTP surface; a resource-use and lock-hold concern.

**Disposition:** not fixed in this phase. Putting the cap into `normalizeDomains` would newly refuse OIDC and direct-caller input that is accepted today, which a refactor that preserves behaviour must not do.

**Suggested fix (follow-up):** in `normalizeDomains`, refuse `normalized.length > 50` with `protocol.refuse("at most 50 email domains")` and tighten the per-domain test to `domain.length <= 253` with every label at most 63 characters; keep the SAML schema cap as the early HTTP refusal. Pin it in `OrganizationConnectionLifecycle.test.ts` and note the new refusal in the OIDC store's changeset.

## Residuals

(Later plans append here: items the phase documents but does not fix.)
