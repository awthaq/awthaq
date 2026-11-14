// Phase 6 Wave 0 oracle (REC-04), frozen from the source at phase base 3be32564 and never edited after
// its add commit. It reads the record stores as text and never imports them, so it cannot be derived from
// the code it guards. It pins, per `*Records` module, the sorted multiset of every StoreUnavailable label
// and store-named string, the `Ref.make` / `Semaphore.make` counts of its `layerMemory`, and the
// `SqlStore.atomically` lock-key template literals. The label scanner accepts exactly two closure
// spellings, today's template closure and `StoreFailure.labelled("<Store>")`, because the label is
// `<Store>.<operation>` under both (`StoreFailure.test.ts` proves `labelled` builds that string): the
// file survives the scaffolding adoption unedited.
import { readFileSync } from "node:fs";
import { assert, describe, it } from "@effect/vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

const sortedBy = (items: ReadonlyArray<string>): Array<string> =>
  [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The two accepted closure spellings; each yields the store name.
const TODAY =
  /const (unavailable|failing) = \((operation|method): string\) =>\s*StoreFailure\.orStoreUnavailable\(\s*`(\w+)\.\$\{(operation|method)\}`,?\s*\);/g;
const ADOPTED = /const (unavailable|failing) = StoreFailure\.labelled\("(\w+)"\);/g;

interface Derived {
  readonly store: string;
  readonly labels: Array<string>;
  readonly nonLiteralCalls: number;
}

/** The store name and sorted labels derived from one record-store source; throws on any other closure spelling. */
const scan = (text: string, binding: string): Derived => {
  const stores = [
    ...Array.from(text.matchAll(TODAY))
      .filter((m) => m[1] === binding && m[2] === m[4])
      .map((m) => m[3] ?? ""),
    ...Array.from(text.matchAll(ADOPTED))
      .filter((m) => m[1] === binding)
      .map((m) => m[2] ?? ""),
  ];
  if (stores.length !== 1) {
    throw new Error(`expected exactly one accepted \`${binding}\` closure, found ${stores.length}`);
  }
  const declarations = Array.from(text.matchAll(new RegExp(`const ${escaped(binding)} = `, "g")));
  if (declarations.length !== 1) {
    throw new Error(`expected exactly one \`const ${binding} = \`, found ${declarations.length}`);
  }
  const store = stores[0] ?? "";
  const labels: Array<string> = [];
  for (const m of text.matchAll(
    new RegExp(`(?<![\\w.])${escaped(binding)}\\("([A-Za-z]+)"\\)`, "g"),
  )) {
    labels.push(`${store}.${m[1]}`);
  }
  if (store === "ActiveContextRecords") {
    for (const m of text.matchAll(/(?<![\w.])(?:writeOrganization|writeTeam)\(\s*"([A-Za-z]+)"/g)) {
      labels.push(`${store}.${m[1]}`);
    }
  }
  for (const m of text.matchAll(/"([A-Z][A-Za-z]*Records\.[A-Za-z]+)"/g)) {
    labels.push(m[1] ?? "");
  }
  const nonLiteralCalls = Array.from(
    text.matchAll(new RegExp(`(?<![\\w.])${escaped(binding)}\\((?!")`, "g")),
  ).length;
  return { store, labels: sortedBy(labels), nonLiteralCalls };
};

const LABELS: Record<
  string,
  {
    readonly path: string;
    readonly binding: string;
    readonly labels: ReadonlyArray<string>;
    readonly nonLiteralCalls: number;
  }
> = {
  ImpersonationRecords: {
    path: "packages/admin/src/ImpersonationRecords.ts",
    binding: "unavailable",
    labels: [
      "ImpersonationRecords.closeExpired",
      "ImpersonationRecords.create",
      "ImpersonationRecords.endEpisode",
      "ImpersonationRecords.findBySessionId",
      "ImpersonationRecords.list",
      "ImpersonationRecords.verifyChain",
    ],
    nonLiteralCalls: 0,
  },
  ApiKeyClientRecords: {
    path: "packages/api-key/src/ApiKeyClientRecords.ts",
    binding: "unavailable",
    labels: [
      "ApiKeyClientRecords.deleteByOwner",
      "ApiKeyClientRecords.duplicateId",
      "ApiKeyClientRecords.findById",
      "ApiKeyClientRecords.insert",
      "ApiKeyClientRecords.listByOwner",
      "ApiKeyClientRecords.revoke",
      "ApiKeyClientRecords.rotateSecret",
    ],
    nonLiteralCalls: 0,
  },
  ApiKeyRecords: {
    path: "packages/api-key/src/ApiKeyRecords.ts",
    binding: "unavailable",
    labels: [
      "ApiKeyRecords.deleteByOwner",
      "ApiKeyRecords.duplicateId",
      "ApiKeyRecords.findById",
      "ApiKeyRecords.insert",
      "ApiKeyRecords.listByOwner",
      "ApiKeyRecords.revoke",
      "ApiKeyRecords.rotate",
      "ApiKeyRecords.touch",
    ],
    nonLiteralCalls: 0,
  },
  DeviceClientRecords: {
    path: "packages/device-authorization/src/DeviceClientRecords.ts",
    binding: "unavailable",
    labels: [
      "DeviceClientRecords.findById",
      "DeviceClientRecords.insert",
      "DeviceClientRecords.list",
      "DeviceClientRecords.revoke",
    ],
    nonLiteralCalls: 0,
  },
  DeviceGrantRecords: {
    path: "packages/device-authorization/src/DeviceGrantRecords.ts",
    binding: "unavailable",
    labels: [
      "DeviceGrantRecords.claim",
      "DeviceGrantRecords.consume",
      "DeviceGrantRecords.decide",
      "DeviceGrantRecords.deleteByUser",
      "DeviceGrantRecords.findByDeviceHash",
      "DeviceGrantRecords.findByUserHash",
      "DeviceGrantRecords.insert",
      "DeviceGrantRecords.listByUser",
      "DeviceGrantRecords.purgeExpired",
      "DeviceGrantRecords.raiseInterval",
      "DeviceGrantRecords.remove",
      "DeviceGrantRecords.touchPoll",
    ],
    nonLiteralCalls: 0,
  },
  SigningKeyRecords: {
    path: "packages/jwt/src/SigningKeyRecords.ts",
    binding: "unavailable",
    labels: [
      "SigningKeyRecords.create",
      "SigningKeyRecords.create",
      "SigningKeyRecords.findByKid",
      "SigningKeyRecords.findCurrent",
      "SigningKeyRecords.listVerifiable",
      "SigningKeyRecords.markRotated",
      "SigningKeyRecords.retire",
    ],
    nonLiteralCalls: 0,
  },
  ActiveContextRecords: {
    path: "packages/organization/src/ActiveContextRecords.ts",
    binding: "unavailable",
    labels: [
      "ActiveContextRecords.clearOrganization",
      "ActiveContextRecords.clearOrganizationForUser",
      "ActiveContextRecords.clearTeam",
      "ActiveContextRecords.deleteAllByUser",
      "ActiveContextRecords.findBySessionId",
      "ActiveContextRecords.setOrganization",
      "ActiveContextRecords.setTeam",
      "ActiveContextRecords.unsetOrganization",
      "ActiveContextRecords.unsetTeam",
    ],
    nonLiteralCalls: 2,
  },
  ConnectionRecords: {
    path: "packages/organization/src/ConnectionRecords.ts",
    binding: "unavailable",
    labels: [
      "ConnectionRecords.create",
      "ConnectionRecords.findByEmailDomain",
      "ConnectionRecords.findById",
      "ConnectionRecords.listByOrganization",
      "ConnectionRecords.remove",
      "ConnectionRecords.remove",
      "ConnectionRecords.removeAllForOrganization",
      "ConnectionRecords.update",
      "ConnectionRecords.update",
      "ConnectionRecords.update",
      "ConnectionRecords.write",
    ],
    nonLiteralCalls: 0,
  },
  InvitationRecords: {
    path: "packages/organization/src/InvitationRecords.ts",
    binding: "unavailable",
    labels: [
      "InvitationRecords.countPendingByInviter",
      "InvitationRecords.create",
      "InvitationRecords.findById",
      "InvitationRecords.findByTokenHash",
      "InvitationRecords.findPendingByEmailAndOrg",
      "InvitationRecords.listByEmail",
      "InvitationRecords.listByInviter",
      "InvitationRecords.listByOrganization",
      "InvitationRecords.purgeExpired",
      "InvitationRecords.removeAllForOrganization",
      "InvitationRecords.removeAllForUser",
      "InvitationRecords.setTokenHash",
      "InvitationRecords.transition",
      "InvitationRecords.transition",
    ],
    nonLiteralCalls: 0,
  },
  MembershipRecords: {
    path: "packages/organization/src/MembershipRecords.ts",
    binding: "unavailable",
    labels: [
      "MembershipRecords.countByOrganization",
      "MembershipRecords.countOwners",
      "MembershipRecords.create",
      "MembershipRecords.deleteAllByUser",
      "MembershipRecords.findByUserAndOrg",
      "MembershipRecords.listByOrganization",
      "MembershipRecords.listByUser",
      "MembershipRecords.remove",
      "MembershipRecords.removeAllForOrganization",
      "MembershipRecords.updateRole",
    ],
    nonLiteralCalls: 0,
  },
  OrganizationRecords: {
    path: "packages/organization/src/OrganizationRecords.ts",
    binding: "unavailable",
    labels: [
      "OrganizationRecords.create",
      "OrganizationRecords.delete",
      "OrganizationRecords.findById",
      "OrganizationRecords.findBySlug",
      "OrganizationRecords.listByIds",
      "OrganizationRecords.listPage",
      "OrganizationRecords.setSuspended",
      "OrganizationRecords.update",
      "OrganizationRecords.update",
    ],
    nonLiteralCalls: 0,
  },
  OrgRoleRecords: {
    path: "packages/organization/src/OrgRoleRecords.ts",
    binding: "unavailable",
    labels: [
      "OrgRoleRecords.countByOrganization",
      "OrgRoleRecords.create",
      "OrgRoleRecords.findById",
      "OrgRoleRecords.listByOrganization",
      "OrgRoleRecords.remove",
      "OrgRoleRecords.removeAllForOrganization",
      "OrgRoleRecords.update",
    ],
    nonLiteralCalls: 0,
  },
  TeamRecords: {
    path: "packages/organization/src/TeamRecords.ts",
    binding: "unavailable",
    labels: [
      "TeamRecords.addTeamMember",
      "TeamRecords.countTeamsByOrganization",
      "TeamRecords.createTeam",
      "TeamRecords.findTeamById",
      "TeamRecords.findTeamByIdAnyOrg",
      "TeamRecords.findTeamMembership",
      "TeamRecords.getAncestors",
      "TeamRecords.getDescendants",
      "TeamRecords.getSubtree",
      "TeamRecords.listTeamMembers",
      "TeamRecords.listTeamsByOrganization",
      "TeamRecords.listTeamsByUser",
      "TeamRecords.moveTeam",
      "TeamRecords.removeAllTeamsForOrganization",
      "TeamRecords.removeTeam",
      "TeamRecords.removeTeamMember",
      "TeamRecords.removeUserFromAllTeams",
      "TeamRecords.removeUserFromOrganizationTeams",
      "TeamRecords.updateTeam",
      "TeamRecords.updateTeamMemberRole",
    ],
    nonLiteralCalls: 0,
  },
  SamlRecords: {
    path: "packages/saml/src/SamlRecords.ts",
    binding: "unavailable",
    labels: [
      "SamlRecords.create",
      "SamlRecords.findByDomain",
      "SamlRecords.findById",
      "SamlRecords.findSession",
      "SamlRecords.findSessions",
      "SamlRecords.listByOrganization",
      "SamlRecords.listSpKeys",
      "SamlRecords.pruneSessions",
      "SamlRecords.refresh",
      "SamlRecords.remove",
      "SamlRecords.removeSession",
      "SamlRecords.saveSession",
      "SamlRecords.saveSpKey",
      "SamlRecords.update",
    ],
    nonLiteralCalls: 0,
  },
  ScimRecords: {
    path: "packages/scim/src/ScimRecords.ts",
    binding: "unavailable",
    labels: [
      "ScimRecords.createConnection",
      "ScimRecords.find",
      "ScimRecords.findByExternalId",
      "ScimRecords.findByName",
      "ScimRecords.findConnectionByTokenHash",
      "ScimRecords.link",
      "ScimRecords.linksOfResource",
      "ScimRecords.list",
      "ScimRecords.listConnections",
      "ScimRecords.removeAllForOrganization",
      "ScimRecords.revokeConnection",
      "ScimRecords.setExternalId",
      "ScimRecords.unlink",
      "ScimRecords.unlinkResource",
    ],
    nonLiteralCalls: 0,
  },
  WebhookRecords: {
    path: "packages/webhooks/src/WebhookRecords.ts",
    binding: "failing",
    labels: [
      "WebhookRecords.bumpDead",
      "WebhookRecords.claimDue",
      "WebhookRecords.clearDead",
      "WebhookRecords.createEndpoint",
      "WebhookRecords.defer",
      "WebhookRecords.deleteBySubject",
      "WebhookRecords.deleteEndpoint",
      "WebhookRecords.disableFailing",
      "WebhookRecords.enqueue",
      "WebhookRecords.findDelivery",
      "WebhookRecords.findEndpoint",
      "WebhookRecords.findEndpointForDelivery",
      "WebhookRecords.listBySubject",
      "WebhookRecords.listDeliveries",
      "WebhookRecords.listEnabledEndpoints",
      "WebhookRecords.listEndpoints",
      "WebhookRecords.markDead",
      "WebhookRecords.markSucceeded",
      "WebhookRecords.pruneFinished",
      "WebhookRecords.redrive",
      "WebhookRecords.reschedule",
      "WebhookRecords.setDisabled",
      "WebhookRecords.setSecrets",
      "WebhookRecords.updateEndpoint",
    ],
    nonLiteralCalls: 0,
  },
};

const STATE: Record<
  string,
  { readonly path: string; readonly refs: number; readonly semaphores: number }
> = {
  ImpersonationRecords: {
    path: "packages/admin/src/ImpersonationRecords.ts",
    refs: 2,
    semaphores: 1,
  },
  ApiKeyClientRecords: {
    path: "packages/api-key/src/ApiKeyClientRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  ApiKeyRecords: { path: "packages/api-key/src/ApiKeyRecords.ts", refs: 1, semaphores: 0 },
  DeviceClientRecords: {
    path: "packages/device-authorization/src/DeviceClientRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  DeviceGrantRecords: {
    path: "packages/device-authorization/src/DeviceGrantRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  SigningKeyRecords: { path: "packages/jwt/src/SigningKeyRecords.ts", refs: 1, semaphores: 0 },
  ActiveContextRecords: {
    path: "packages/organization/src/ActiveContextRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  ConnectionRecords: {
    path: "packages/organization/src/ConnectionRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  InvitationRecords: {
    path: "packages/organization/src/InvitationRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  MembershipRecords: {
    path: "packages/organization/src/MembershipRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  OrganizationRecords: {
    path: "packages/organization/src/OrganizationRecords.ts",
    refs: 1,
    semaphores: 0,
  },
  OrgRoleRecords: { path: "packages/organization/src/OrgRoleRecords.ts", refs: 1, semaphores: 0 },
  TeamRecords: { path: "packages/organization/src/TeamRecords.ts", refs: 1, semaphores: 0 },
  SamlRecords: { path: "packages/saml/src/SamlRecords.ts", refs: 1, semaphores: 0 },
  ScimRecords: { path: "packages/scim/src/ScimRecords.ts", refs: 1, semaphores: 0 },
  WebhookRecords: { path: "packages/webhooks/src/WebhookRecords.ts", refs: 1, semaphores: 0 },
};

const LOCK_KEYS: Record<string, ReadonlyArray<string>> = {
  "packages/organization/src/TeamRecords.ts": [`organization_team:org:\${organizationId}`],
  "packages/organization/src/MembershipRecords.ts": [
    `organization_membership:org:\${input.organizationId}`,
    `organization_membership:org:\${organizationId}`,
    `organization_membership:owner:\${input.userId}`,
  ],
  "packages/organization/src/InvitationRecords.ts": [
    `organization_invitation:inviter:\${input.inviterId}`,
  ],
  "packages/organization/src/OrgRoleRecords.ts": [`organization_role:org:\${input.organizationId}`],
  "packages/webhooks/src/WebhookRecords.ts": [
    `webhooks_endpoint:tenant:\${stamped.tenantId ?? "-"}`,
  ],
  "packages/organization/src/DomainClaims.ts": [`organization_domain_claim:org:\${organizationId}`],
  "packages/qadi/src/UserClaims.ts": [`qadi_claims:user:\${userId}`],
  "packages/two-factor/src/TwoFactorStore.ts": [`two_factor_recovery_code:user:\${userId}`],
  "examples/plugin-template/src/Template.ts": [`notes_note:owner:\${input.owner}`],
};

const LOCK_KEY = /`[a-z_]+:[a-z]+:\$\{[^`]*`/g;

const count = (text: string, pattern: RegExp): number => Array.from(text.matchAll(pattern)).length;

describe("record-store scaffolding pins (Wave 0)", () => {
  it("the scanner accepts today's and the adopted closure and refuses any other spelling", () => {
    const today = [
      "const unavailable = (operation: string) =>",
      `  StoreFailure.orStoreUnavailable(\`Probe.\${operation}\`);`,
      'const read = Effect.pipe(unavailable("read"));',
    ].join("\n");
    const adopted = [
      'const unavailable = StoreFailure.labelled("Probe");',
      'const read = Effect.pipe(unavailable("read"));',
    ].join("\n");
    const concatenated = [
      "const unavailable = (operation: string) =>",
      '  StoreFailure.orStoreUnavailable("Probe." + operation);',
      'const read = Effect.pipe(unavailable("read"));',
    ].join("\n");
    assert.deepStrictEqual(scan(today, "unavailable").labels, ["Probe.read"]);
    assert.deepStrictEqual(scan(adopted, "unavailable").labels, ["Probe.read"]);
    assert.throws(() => scan(concatenated, "unavailable"));
  });

  it("every record store's labels, frozen at 3be32564", () => {
    let total = 0;
    for (const [name, expected] of Object.entries(LABELS)) {
      const derived = scan(read(expected.path), expected.binding);
      assert.strictEqual(derived.store, name, `${name}: store name`);
      assert.deepStrictEqual(derived.labels, [...expected.labels], `${name}: labels`);
      assert.strictEqual(
        derived.nonLiteralCalls,
        expected.nonLiteralCalls,
        `${name}: non-literal calls`,
      );
      total += derived.labels.length;
    }
    assert.strictEqual(Object.keys(LABELS).length, 16);
    assert.strictEqual(total, 176);
  });

  it("every layerMemory keeps today's Ref and Semaphore count", () => {
    for (const [name, expected] of Object.entries(STATE)) {
      const text = read(expected.path);
      assert.strictEqual(
        count(text, /(?<![\w.])Ref\.make(?![\w])/g),
        expected.refs,
        `${name}: Ref.make`,
      );
      assert.strictEqual(
        count(text, /(?<![\w.])Semaphore\.make(?![\w])/g),
        expected.semaphores,
        `${name}: Semaphore.make`,
      );
    }
  });

  it("the 11 SqlStore.atomically lock keys, byte for byte", () => {
    let total = 0;
    for (const [path, expected] of Object.entries(LOCK_KEYS)) {
      const found = sortedBy(
        Array.from(read(path).matchAll(LOCK_KEY)).map((m) => m[0].slice(1, -1)),
      );
      assert.deepStrictEqual(found, sortedBy(expected), path);
      total += found.length;
    }
    assert.strictEqual(Object.keys(LOCK_KEYS).length, 9);
    assert.strictEqual(total, 11);
  });
});
