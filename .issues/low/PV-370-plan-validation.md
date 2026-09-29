---
ID: "PV-370"
Title: "BEH-EA-244 promises an explicit per-connection opt-in for IdP-initiated login; @awthaq/saml refuses every unsolicited response and has no such setting"
Level: low
Category: "correctness"
Status: open
Package: "saml"
Source: "packages/saml/src/Saml.ts:26"
Auditor: "plan-validation"
Auditor-Type: "validation"
Audit-Date: 2026-09-29
---
# PV-370 — BEH-EA-244 promises an explicit per-connection opt-in for IdP-initiated login; @awthaq/saml refuses every unsolicited response and has no such setting

`LOW` · `correctness` · `saml` · found while wiring `29-saml-sp.feature` (P20a)

Status: **open**

## Summary

`spec/behaviors/29-saml-sp.md` (BEH-EA-244) and the scenario "An unsolicited response is accepted only when the connection explicitly opts in" (REQ-EA-904) describe a per-connection opt-in to IdP-initiated login. The shipped plugin has none: `Saml.acs` requires the `__Host-saml-request` state cookie of a login this server started, so every unsolicited response is refused (the package header lists "IdP-initiated login" under "Not built"). The safe half (refusal by default, REQ-EA-903) is wired and passes; the opt-in half is `@skip`ped in the feature with this id.

## Evidence

`packages/saml/src/Saml.ts` — `consumeRequest` fails with `noRequestState` when the cookie is absent; `SamlConnections.create` has no `idpInitiated` field.

## Recommended fix

Either implement the opt-in (a connection flag, an unsolicited-response path that still runs the whole chain except the request-id step and adds a replay-protected assertion id and a `RelayState` allow-list), or amend BEH-EA-244 and REQ-EA-904 to say IdP-initiated login is not offered. The second is the smaller change and matches the plugin's own README.

## Comments

_Triage notes and discussion append here._
