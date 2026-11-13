---
plan: 33-browser-return-trip
ticket: 04
title: "Docs for SessionDelivery.land: ADR-EA-045 revision 1.1, the OAuth spec, the server README, plugin authoring, changeset"
type: execute
wave: 1
depends_on: [02]
files_modified:
  - spec/decisions/045-session-lifecycle-on-the-contract.md
  - spec/behaviors/16-oauth.md
  - packages/server/README.md
  - docs/plugin-authoring.md
  - .changeset/server-session-delivery-land.md
autonomous: true
requirements: [REQ-EA-1543]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "No document in spec/, docs/ or packages/*/README.md names SessionDelivery.redirect or `redirect(response, issued)`"
    - "ADR-EA-045 revision 1.1 says land needs MintGrant and owns the PV-016 landing choice"
  artifacts:
    - ".changeset/server-session-delivery-land.md with a Migration: line"
  key_links:
    - "ADR-EA-045 decision 2 <-> packages/server/src/SessionDelivery.ts land"
---
Status: done (uncommitted)
Blocked by: 02

<objective>
Bring every document that names `SessionDelivery.redirect` in line with ticket 02, and amend ADR-EA-045 (PLAN.md §6). No decision is reversed: decision 2's list of `MintGrant` functions changes one name and gains one sentence.

Purpose: plugin authors and the ADR describe the function that exists.
Output: four edited docs and one changeset.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (section 6)
@spec/decisions/045-session-lifecycle-on-the-contract.md (Document Control rows 1-15, decision 2 at :30)
@spec/behaviors/16-oauth.md (Document Control, :195)
@packages/server/README.md (:60)
@docs/plugin-authoring.md (:214)
@.changeset/oauth-same-site-bounce.md (format to copy)
</context>

<tasks>
<task type="auto">
  <name>Task 1: ADR-EA-045 revision 1.1 and the OAuth spec</name>
  <files>spec/decisions/045-session-lifecycle-on-the-contract.md, spec/behaviors/16-oauth.md</files>
  <read_first>spec/decisions/045-session-lifecycle-on-the-contract.md (whole, 60 lines); spec/behaviors/16-oauth.md lines 1-15 and 190-197</read_first>
  <action>
    In ADR-EA-045, decision 2: change "`respond(mint)`, `deliverBearer`, `deliverExchanged` and `redirect` need `MintGrant`" to "… and `land` need `MintGrant`". Append to decision 2: "`land(location, issued, { bounce })` lands a browser return trip (the OAuth callback, the SAML ACS): the same-site interstitial while the session cookie is `SameSite=Strict` and `bounce` holds, a `302` otherwise, and it declines when nothing was minted (BEH-EA-122, BEH-EA-353)." Bump Document Control Revision to 1.1. Add Change History "1.1 (<today>): `SessionDelivery.redirect` is replaced by `land`, which owns the PV-016 landing choice for every browser return trip (architecture plan 33)". Do not touch the Status or any other decision.

    In `16-oauth.md:195`, change "rides the redirect or the interstitial through `SessionDelivery.redirect` (a landing that mints nothing, such as an account link, declines)" to "rides the redirect or the interstitial through `SessionDelivery.land`, which chooses between them and declines a landing that mints nothing (such as an account link)". Bump Revision 1.6 to 1.7 with a Change History entry naming architecture plan 33.
  </action>
  <verify><automated>grep -c -F 'redirect` need' spec/decisions/045-session-lifecycle-on-the-contract.md | grep -qx 0 && grep -c -F 'SessionDelivery.redirect' spec/behaviors/16-oauth.md | grep -qx 0 && echo ok</automated></verify>
  <acceptance_criteria>
    - `grep -c -F 'SessionDelivery.redirect' spec/behaviors/16-oauth.md` = 0 (baseline at HEAD: 1).
    - `grep -c -F '| Revision | 1.1 |' spec/decisions/045-session-lifecycle-on-the-contract.md` = 1 (baseline: 0).
    - `grep -c 'land(location, issued' spec/decisions/045-session-lifecycle-on-the-contract.md` = 1 (baseline: 0).
  </acceptance_criteria>
  <done>The ADR and the OAuth behaviour describe `land`.</done>
</task>

<task type="auto">
  <name>Task 2: server README, plugin authoring, changeset</name>
  <files>packages/server/README.md, docs/plugin-authoring.md, .changeset/server-session-delivery-land.md</files>
  <read_first>packages/server/README.md line 60; docs/plugin-authoring.md line 214; .changeset/oauth-same-site-bounce.md</read_first>
  <action>
    In `packages/server/README.md:60`, change "`redirect`, `deliverBearer`, …" to "`land` (a browser return trip's landing: the same-site interstitial under a `Strict` session cookie, else a `302`), `deliverBearer`, …".

    In `docs/plugin-authoring.md:214`, change "`redirect(response, issued)` puts the cookie on a browser navigation" to "`land(location, issued, { bounce })` ends a browser return trip: it answers the same-site interstitial while the session cookie is `Strict` (so the landing request carries it) or a `302`, puts the cookie on it, and declines when `issued` is `undefined`".

    Create `.changeset/server-session-delivery-land.md` with frontmatter `"@awthaq/server": minor` and `"@awthaq/oauth": patch`. Body: "`SessionDelivery.redirect` is replaced by `SessionDelivery.land`, which owns the PV-016 landing choice (architecture plan 33)." Then one paragraph: OAuth's callback answers exactly as before. Then the line "Migration: replace `SessionDelivery.redirect(HttpServerResponse.redirect(url), issued)` with `SessionDelivery.land(url, issued)`; pass `{ bounce: false }` to keep the plain `302` under a `Strict` session cookie, and `undefined` for `issued` to decline `Mints`. ADR-EA-045 revision 1.1."
  </action>
  <verify><automated>test -f .changeset/server-session-delivery-land.md && grep -q '^Migration:' .changeset/server-session-delivery-land.md && grep -c -F 'redirect(response, issued)' docs/plugin-authoring.md | grep -qx 0 && echo ok</automated></verify>
  <acceptance_criteria>
    - `grep -c -F 'redirect(response, issued)' docs/plugin-authoring.md` = 0 (baseline at HEAD: 1).
    - `grep -c -F '`land`' packages/server/README.md` is at least 1 (baseline at HEAD: 0).
    - `pnpm format:check` passes on the touched files (`npx oxfmt --check <paths>`).
  </acceptance_criteria>
  <done>Plugin authors are told to call `land`.</done>
</task>
</tasks>

<verification>
grep -rn -F 'SessionDelivery.redirect' spec docs packages/*/README.md | grep -v 'spec/behaviors/29-saml-sp.md' | wc -l   # baseline at HEAD: 1 (16-oauth.md:195); expect 0. 29-saml-sp.md:331 and traceability.md:254 belong to ticket 05
pnpm spec:verify
</verification>

<success_criteria>
After tickets 04 and 05, nothing in spec, docs or the READMEs names `redirect` as a `SessionDelivery` function. ADR-EA-045 is at 1.1.
</success_criteria>

## Comments
