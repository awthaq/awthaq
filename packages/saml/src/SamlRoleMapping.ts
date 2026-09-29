// @awthaq/saml — SamlRoleMapping
//
// BEH-EA-307: what an IdP's assertion says about roles, turned into an organization's roles by rules an administrator
// wrote, under a ceiling. The rules read ONLY the verified assertion (`SignedAssertion.attributes`); what they may confer
// is bounded by `Organization.checkRoleCeiling`/`syncMemberRoles` (RRM-001's `canGrant` rule with the connection's role
// ceiling standing in for a caller), so a connection cannot mint `owner` unless its ceiling holds it, and the configuration
// gate `allowOwnerRoleMapping` (default off) says who may ever hold that ceiling.

import type { SignedAssertion } from "./SamlAssertion.ts";
import type { RoleMapping } from "./SamlRecords.ts";

/** The names an administrator may not put in a ceiling or a rule unless the deployment allowed it. */
export const OWNER_ROLE = "owner";

/** Every value of the attribute called `name` (case-insensitive; several attributes of one name are pooled). */
const valuesOf = (assertion: SignedAssertion, name: string): ReadonlyArray<string> => {
  const wanted = name.toLowerCase();
  return Object.entries(assertion.attributes)
    .filter(([attributeName]) => attributeName.toLowerCase() === wanted)
    .flatMap(([, values]) => values.filter((value) => value !== ""));
};

/**
 * The roles the mapping gives this assertion: the union (in rule order, without repeats) of every rule that matched, else
 * `defaultRoles`; `undefined` when nothing matched and there is no default (the sign-in then changes no membership). A rule
 * with a `value` matches when the attribute holds exactly that value (a multi-valued `groups` attribute matches on any
 * of its values); a rule without one matches when the attribute is present at all.
 */
export const rolesFor = (
  mapping: RoleMapping,
  assertion: SignedAssertion,
): ReadonlyArray<string> | undefined => {
  const roles: Array<string> = [];
  let matched = false;
  for (const rule of mapping.rules) {
    const values = valuesOf(assertion, rule.attribute);
    const hit = rule.value === undefined ? values.length > 0 : values.includes(rule.value);
    if (!hit) continue;
    matched = true;
    for (const role of rule.roles) if (!roles.includes(role)) roles.push(role);
  }
  if (matched) return roles;
  return mapping.defaultRoles.length > 0 ? mapping.defaultRoles : undefined;
};

/** Every role name a mapping mentions: its rules' roles, its defaults and its ceiling. */
export const rolesMentioned = (mapping: RoleMapping): ReadonlyArray<string> => [
  ...new Set([
    ...mapping.rules.flatMap((rule) => rule.roles),
    ...mapping.defaultRoles,
    ...mapping.ceiling,
  ]),
];

/** `true` when the mapping could confer `owner` (it is in the ceiling, a rule or the defaults). */
export const mentionsOwner = (mapping: RoleMapping): boolean =>
  rolesMentioned(mapping).includes(OWNER_ROLE);
