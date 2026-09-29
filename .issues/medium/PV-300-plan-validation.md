---
ID: "PV-300"
Title: "Organization existence oracles: `leave`, the team endpoints with teams disabled, `teams/mine` and a team roster answer a non-member differently for an existing organization than for an unknown id"
Level: medium
Category: "security"
Status: resolved
Package: "organization"
Source: "packages/organization/src/Organization.ts:2416"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-300 — Organization existence oracles on `leave` and the team endpoints

`MEDIUM` · `security` · `organization` · found while wiring `31-organization.feature` (P20a, MTI-011); not in the original audit

Status: **resolved**

## Summary

MTI-009 promises that every `/organization/:organizationId/*` endpoint answers a non-member byte-identically for an existing and a non-existent id. Wiring the adversarial cross-tenant Rule (BEH-EA-259) showed four endpoints that did not keep it:

- `POST /organization/:id/leave` answered `404 {"_tag":"MembershipNotFound"}` for an existing organization and `404 {"_tag":"OrganizationNotFound"}` for an unknown id.
- With teams disabled (the default) every team endpoint ran the feature gate before the membership gate, so an outsider got `403 TeamsDisabled` for an existing organization and `404 OrganizationNotFound` for an unknown one.
- `GET /organization/:id/teams/mine` had no membership gate at all: `200 []` for an existing organization, `404` for an unknown id.
- `GET /organization/:id/teams/:teamId/members` looked the team up before checking membership, so an outsider could tell a real team of an existing organization from an unknown one.

Each one lets an authenticated caller from another tenant enumerate which organization ids exist.

## Fix

`Organization.leave` answers a non-member `OrganizationNotFound`; a new `requireTeamsFor(callerId, organizationId)` (membership gate, then the teams feature gate) replaces every bare `requireTeamsEnabled` in the team operations. Regression tests: `packages/organization/test/AuthHttp.test.ts` (extended probe list, and a teams-disabled case) and the `BEH-EA-259` scenarios in `features/features/10-organization/31-organization.feature`.

## Comments

**Resolved (2026-09-29):** fixed in P20a alongside the feature wiring; see the files above.
