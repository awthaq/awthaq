---
plan: 33-browser-return-trip
ticket: 05
title: "Docs for the ACS landing: BEH-EA-353, BEH-EA-055, the SAML README, traceability, changeset"
type: execute
wave: 2
depends_on: [03]
files_modified:
  - spec/behaviors/29-saml-sp.md
  - spec/behaviors/07-sessions.md
  - packages/saml/README.md
  - spec/traceability.md
  - .changeset/saml-acs-same-site-bounce.md
autonomous: true
requirements: [REQ-EA-1540, REQ-EA-1541]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "BEH-EA-353 (or the renumbered id per PLAN Q2) states the ACS landing rule and points at SamlHttp.test.ts"
    - "No document claims the default session cookie lands a SAML sign-in signed in without the interstitial (saml README :100 corrected)"
    - "pnpm spec:verify:strict passes"
  artifacts:
    - "spec/behaviors/29-saml-sp.md ## BEH-EA-353 section"
    - ".changeset/saml-acs-same-site-bounce.md with a Migration: line"
  key_links:
    - "traceability §1 row 29 lists BEH-EA-353; §5 SamlHttp.test.ts row names the landing chain"
---
Status: done (uncommitted)
Blocked by: 03

<objective>
Record ticket 03's behaviour change everywhere the convention requires: the behaviour entry with its Document Control, the cross-reference in BEH-EA-055, the SAML README (whose current advice is wrong), traceability, and a changeset with a Migration line (PLAN.md §6).

Purpose: the spec and the docs say what the ACS does, and stop telling users the default cookie is safe for a SAML landing.
Output: BEH-EA-353, three amended docs, one changeset.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.4 item 2, 6, 10 Q2)
@spec/behaviors/29-saml-sp.md (Document Control :1-13, BEH-EA-318 at :299 and the end of the file, :331)
@spec/behaviors/16-oauth.md (:58, BEH-EA-122's interstitial text: the shape to mirror)
@spec/behaviors/07-sessions.md (Document Control :1-13, :154)
@packages/saml/README.md (:46, :100)
@spec/traceability.md (Document Control, §1 row for file 29, §5 rows for SamlHttp.test.ts and SessionLifecycle.test.ts :254)
@spec/scripts/verify-traceability.sh (:383-411: BEH-EA ids must be contiguous)
</context>

<tasks>
<task type="auto">
  <name>Task 1: BEH-EA-353 and BEH-EA-055</name>
  <files>spec/behaviors/29-saml-sp.md, spec/behaviors/07-sessions.md</files>
  <read_first>spec/behaviors/29-saml-sp.md lines 1-20 and 295-end; spec/behaviors/16-oauth.md line 58; spec/behaviors/07-sessions.md lines 1-15 and 150-156; spec/scripts/verify-traceability.sh lines 383-411</read_first>
  <action>
    First choose the id (PLAN.md Q2). Run `grep -ohE '^##[[:space:]]+BEH-EA-[0-9]{3}' spec/behaviors/*.md | grep -oE '[0-9]{3}' | sort -n | tail -1`. If the result is 352, use 353. If it is lower, use (result + 1), record the renumbering under "Decisions taken" in `.planning/33-browser-return-trip/PLAN.md`, and report it so the README numbers table can be updated. This ticket's text calls the id BEH-EA-353.

    Append a new section to `29-saml-sp.md` after the last behaviour, in the file's format: `## BEH-EA-353: The ACS's first landing request carries a Strict session`, a `text` REQUIREMENT block, then prose. Use the draft in PLAN.md §6 verbatim, adjusting only the id. Fix the previous/next navigation lines of the section before it, and add the new section's own. Change `:331`'s "rides the redirect through `SessionDelivery.redirect`" to "rides the landing through `SessionDelivery.land` (the interstitial under a `Strict` cookie, BEH-EA-353)". Bump Revision 1.12 to 1.13, with Change History "1.13 (<today>): BEH-EA-353: under a `Strict` session cookie the ACS lands through the same-site interstitial, so the first landing request is signed in (architecture plan 33)".

    In `07-sessions.md:154`, change "(the OAuth callback avoids this by default with its same-site bounce page, BEH-EA-122)" to "(the OAuth callback and the SAML ACS avoid this by default with the same-site bounce page, BEH-EA-122, BEH-EA-353)". Bump Revision 1.11 to 1.12 with a Change History entry naming architecture plan 33.
  </action>
  <verify><automated>pnpm spec:verify:strict</automated></verify>
  <acceptance_criteria>
    - `grep -c '^## BEH-EA-353' spec/behaviors/29-saml-sp.md` = 1 (baseline at HEAD: 0), or the renumbered id.
    - `grep -c -F 'SessionDelivery.redirect' spec/behaviors/29-saml-sp.md` = 0 (baseline at HEAD: 1).
    - `grep -c 'BEH-EA-353' spec/behaviors/07-sessions.md` = 1 (baseline: 0).
    - `pnpm spec:verify:strict` passes; in particular the "BEH-EA id integrity" check reports contiguous ids.
  </acceptance_criteria>
  <done>The behaviour exists with a contiguous id and is cross-referenced from BEH-EA-055.</done>
</task>

<task type="auto">
  <name>Task 2: SAML README, traceability, changeset</name>
  <files>packages/saml/README.md, spec/traceability.md, .changeset/saml-acs-same-site-bounce.md</files>
  <read_first>packages/saml/README.md lines 40-50 and 98-102; spec/traceability.md Document Control and the rows that name 29-saml-sp, SamlHttp.test.ts and SessionLifecycle.test.ts; .changeset/oauth-same-site-bounce.md</read_first>
  <action>
    In `packages/saml/README.md:46`, change "then `302` to the callback with the session cookie" to "then, with the session cookie, the same-site interstitial (`200 text/html`, meta refresh to the callback) while the session cookie is `SameSite=Strict` (the default), or a `302` to the callback under `Lax`/`None` (BEH-EA-353)". At `:100`, replace the sentence that begins "A session cookie in `SameSite=Strict` mode is not sent on the first navigation after a cross-site POST" with: "The IdP's POST is cross-site, so a `302` would keep the landing request in a cross-site chain that withholds a `Strict` cookie. Under the default `Strict` cookie the ACS therefore answers a same-site interstitial whose meta refresh carries the session on the first landing request; `SessionCookie.config({ mode: SessionCookie.HostLax })` keeps the plain `302` (BEH-EA-353, BEH-EA-055)."

    In `spec/traceability.md`:
    - §1: the row for `29-saml-sp.md` adds 353 to its BEH-EA range.
    - §5: there is no row for `packages/saml/test/SamlHttp.test.ts` at HEAD (the SAML rows are at `:320-322`). Add one after the `SamlSignIn.test.ts` row (`:322`): "`packages/saml/test/SamlHttp.test.ts` | BEH-EA-238..245 over real HTTP (login redirect and request cookie, metadata, the uniform 400); BEH-EA-353: the ACS landing chain in the browser model, signed in on the first landing request under `Strict` (interstitial) and under `HostLax` (`302`), and the interstitial escapes the landing URL (REQ-EA-1540..1542)".
    - The `SessionLifecycle.test.ts` row (`:254`): "`deliverBearer`, `deliverExchanged` and `redirect`" becomes "`deliverBearer`, `deliverExchanged` and `land` (interstitial under `Strict`, `302` with `bounce: false` or under `HostLax`, decline, HTML escaping; REQ-EA-1543)".
    - Bump Revision 1.77 to 1.78 with Change History "1.78 (<today>): BEH-EA-353 (SAML ACS landing) and `SessionDelivery.land` rows (architecture plan 33, tickets 02–05)".

    Create `.changeset/saml-acs-same-site-bounce.md` with frontmatter `"@awthaq/saml": minor`. Title line: "The SAML ACS lands through the same-site interstitial while the session cookie is `SameSite=Strict` (BEH-EA-353)." Then a paragraph explaining why, mirroring `oauth-same-site-bounce.md`, and stating that the ACS contract's success is now `302` or `text/html`. Then: "Migration: a host or test that asserted the ACS's `302` under the default cookie now sees a `200` interstitial with the same `Set-Cookie`; `SessionCookie.config({ mode: SessionCookie.HostLax })` keeps the `302`. A deployment that worked around the signed-out first landing (a client-rendered landing route, a re-navigating page) can drop the workaround. BEH-EA-353, BEH-EA-055."
  </action>
  <verify><automated>pnpm spec:verify:strict && grep -q '^Migration:' .changeset/saml-acs-same-site-bounce.md && echo ok</automated></verify>
  <acceptance_criteria>
    - `grep -c 'use the default or `Lax` mode' packages/saml/README.md` = 0 (baseline at HEAD: 1).
    - `grep -c 'BEH-EA-353' spec/traceability.md` is at least 2 (baseline: 0).
    - `grep -c -F '| Revision | 1.78 |' spec/traceability.md` = 1 (baseline: 0).
    - `npx oxfmt --check` passes on the five touched files.
  </acceptance_criteria>
  <done>PR A's documentation is complete; `pnpm check` can run for the hotfix PR.</done>
</task>
</tasks>

<verification>
pnpm spec:verify:strict
pnpm check   # PR A's plan-level gate; run once tickets 01–05 are all in
</verification>

<success_criteria>
The hotfix PR (01–05) passes `pnpm check`. The behaviour, the session-cookie mode doc, the README and the changeset all describe the ACS landing the same way.
</success_criteria>

## Comments
