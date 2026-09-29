// MTI-001: tenant scoping is enforced at the query level by discipline, so pin
// the discipline. Every SQL statement in `src/*Records.ts` that touches an
// `organization_*` table must filter by a tenant key (organizationId, teamId,
// sessionId, activeOrganizationId, activeTeamId) — or be on the explicit,
// justified allowlist below. A new unscoped query therefore fails CI instead of
// shipping as a cross-tenant read/write. (The type-level half — an
// active-context write needs a membership witness — lives in
// `ActiveContextRecords.test.ts`. Postgres RLS for these tables follows
// ticket 18.)
import { readdirSync, readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const srcDir = new URL("../src/", import.meta.url);

/**
 * Every `sql\`...\`` template body in `source` (statements contain no nested
 * backticks). Identifier quotes are stripped: the statements quote their
 * camelCase columns for Postgres (`"organizationId"`), and the patterns below
 * are written against the bare names.
 */
const statementsOf = (source: string): ReadonlyArray<string> =>
  Array.from(source.matchAll(/\bsql`([^`]*)`/g), (match) =>
    (match[1] ?? "").replace(/"/g, "").replace(/\s+/g, " ").trim(),
  );

const TENANT_KEY =
  /\b(organizationId|teamId|sessionId|activeOrganizationId|activeTeamId)\s*(=|IN\b)/;

/**
 * Statements that legitimately do not filter by a tenant key, each with why.
 * Matched against the whitespace-normalized statement text.
 */
const ALLOWLIST: ReadonlyArray<{ readonly match: RegExp; readonly why: string }> = [
  {
    match: /^SELECT \* FROM organization_org WHERE (id|slug) = /,
    why: "organization_org is the tenant root: its own id/slug IS the tenant key",
  },
  {
    match: /^SELECT \* FROM organization_org WHERE id IN /,
    why: "listByIds: ids come from the caller's own memberships (MembershipRecords.listByUser)",
  },
  {
    match: /^UPDATE organization_org SET .* WHERE id = /,
    why: "tenant root update, after the membership-gated Organization.update",
  },
  {
    match: /^DELETE FROM organization_org WHERE id = /,
    why: "tenant root delete, after the membership-gated Organization.delete",
  },
  {
    match: /^SELECT \* FROM organization_membership WHERE userId = /,
    why: "listByUser: a user's own memberships across organizations, keyed by the caller's identity",
  },
  {
    match: /^DELETE FROM organization_membership WHERE userId = /,
    why: "erasure sweep (CSG-001/DRS-002): deleting a user removes them everywhere",
  },
  {
    match: /^DELETE FROM organization_invitation WHERE inviterId = .* OR lower\(email\) = /,
    why: "erasure sweep (CSG-001): removes every invitation an erased user sent or received, across organizations",
  },
  {
    match: /^SELECT teamId AS teamId FROM organization_team_membership WHERE userId = /,
    why: "erasure sweep (CSG-001): the teams an erased user belongs to, across organizations",
  },
  {
    match: /^DELETE FROM organization_active_context WHERE userId = /,
    why: "erasure sweep (DRS-008): deleting a user removes their session rows everywhere",
  },
  {
    match: /^SELECT \* FROM organization_invitation WHERE id = /,
    why: "findById: the invitation id is the capability; acceptance re-checks the invitee's email",
  },
  {
    match: /^UPDATE organization_invitation SET status = .* WHERE id = /,
    why: "status transition by the invitation's own id, only after a tenant/invitee check in Organization",
  },
  {
    match: /^SELECT \* FROM organization_invitation WHERE tokenHash = /,
    why: "findByTokenHash: the emailed token's hash IS the capability; the landing lookup then checks the invitee's email",
  },
  {
    match: /^UPDATE organization_invitation SET tokenHash = .* WHERE id = /,
    why: "token rotation on resend, by the invitation's own id, after the inviter's permission check",
  },
  {
    match: /^SELECT \* FROM organization_invitation WHERE email = /,
    why: "listByEmail: the invitee's own pending invitations, keyed by their verified email",
  },
  {
    match:
      /^SELECT CAST\(COUNT\(\*\) AS INTEGER\) AS count FROM organization_invitation WHERE inviterId = /,
    why: "per-inviter invitation quota, deployment-wide by design (invitationLimit)",
  },
  {
    match: /^SELECT \* FROM organization_team WHERE id = \$\{id\}$/,
    why: "findTeamByIdAnyOrg: existence-only lookup for the qadi team-member relation (RZS-005)",
  },
  {
    match:
      /^SELECT CAST\(COUNT\(\*\) AS INTEGER\) AS count FROM organization_team_closure WHERE ancestorId = /,
    why: "isInSubtree (OHS-001): keyed by two team ids that Organization.moveTeam has already tenant-checked",
  },
  {
    match: /^DELETE FROM organization_team_closure WHERE descendantId IN /,
    why: "moveTeam closure detach (OHS-001): keyed by the moved team's id, inside the tenant-scoped transaction",
  },
  {
    match: /^DELETE FROM organization_team_closure WHERE descendantId = /,
    why: "removeTeam closure cleanup (OHS-001): keyed by the removed team's id, after its tenant-scoped delete",
  },
  {
    match: /^UPDATE organization_team SET memberCount = memberCount \+ /,
    why: "adjustMemberCount: keyed by the team's unique id, only called after tenant-scoped checks",
  },
];

describe("TenantScoping: every organization_* query is tenant-keyed or allowlisted", () => {
  const files = readdirSync(srcDir).filter((name) => name.endsWith("Records.ts"));
  const all = files.flatMap((file) =>
    statementsOf(readFileSync(new URL(file, srcDir), "utf8"))
      .filter((statement) => /\borganization_[a-z_]+\b/.test(statement))
      .map((statement) => ({ file, statement })),
  );

  it("finds the records files and their statements", () => {
    assert.isAbove(files.length, 5);
    assert.isAbove(all.length, 30);
  });

  it("no statement reads or writes a tenant table without a tenant key or an allowlist entry", () => {
    const offenders = all
      .filter(({ statement }) => !statement.startsWith("INSERT INTO "))
      .filter(({ statement }) => !TENANT_KEY.test(statement))
      .filter(({ statement }) => !ALLOWLIST.some((entry) => entry.match.test(statement)))
      .map(({ file, statement }) => `${file}: ${statement}`);
    assert.deepStrictEqual(offenders, []);
  });

  it("every allowlist entry still matches a real statement (no stale exemptions)", () => {
    const stale = ALLOWLIST.filter(
      (entry) => !all.some(({ statement }) => entry.match.test(statement)),
    ).map((entry) => entry.match.source);
    assert.deepStrictEqual(stale, []);
  });
});
