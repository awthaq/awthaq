---
plan: 33-browser-return-trip
ticket: 09
title: "Roll-up: traceability, server README, plugin authoring, changeset, and the plan gate"
type: execute
wave: 4
depends_on: [04, 05, 07, 08]
files_modified:
  - spec/traceability.md
  - packages/server/README.md
  - docs/plugin-authoring.md
  - .changeset/server-return-trip.md
autonomous: true
requirements: [REQ-EA-1544, REQ-EA-1545, REQ-EA-1547]
estimate: {tasks: 2, size: S}
must_haves:
  truths:
    - "A plugin author reading docs/plugin-authoring.md learns to declare a browser return trip with ReturnTrip.make and to land it with SessionDelivery.land"
    - "spec/traceability.md maps ReturnTrip.test.ts to REQ-EA-1544/1545 and the rules it pins"
    - "pnpm check passes on the whole plan"
  artifacts:
    - "spec/traceability.md revision 1.79 with a ReturnTrip.test.ts row"
    - ".changeset/server-return-trip.md"
  key_links:
    - "docs/plugin-authoring.md -> packages/server/src/ReturnTrip.ts and examples in OAuth.ts/Saml.ts"
---
Status: ready-for-agent
Blocked by: 04, 05, 07, 08

<objective>
Close the plan. Document `ReturnTrip` where plugin authors and readers of the server package look, trace its test file, add the changeset for the new public export, re-measure every count gate of PLAN.md §2.1, and run the plan-level gate.

Purpose: the next plugin with a browser return trip uses the module instead of copying OAuth or SAML.
Output: three edited docs, one changeset, and a green `pnpm check`.
</objective>

<context>
@.planning/33-browser-return-trip/PLAN.md (sections 2.1, 5, 6, 9)
@packages/server/src/ReturnTrip.ts
@packages/server/README.md (:60 and the module list)
@docs/plugin-authoring.md (:212-214, the SessionLifecycle paragraph)
@spec/traceability.md (§5 server rows near :254)
</context>

<tasks>
<task type="auto">
  <name>Task 1: docs, traceability, changeset</name>
  <files>spec/traceability.md, packages/server/README.md, docs/plugin-authoring.md, .changeset/server-return-trip.md</files>
  <read_first>packages/server/README.md; docs/plugin-authoring.md lines 205-220; spec/traceability.md lines 250-258 and its Document Control</read_first>
  <action>
    In `docs/plugin-authoring.md`, after the `SessionDelivery` paragraph (`:214`), add a paragraph headed "A browser return trip". It says: a plugin that sends the browser to a provider and back declares the trip once, with `ReturnTrip.make({ cookie: "__Host-<plugin>-state", returnsBy: "redirect" | "post" })` from `@awthaq/server` ("redirect" for a provider that returns by a top-level GET, which gives a `SameSite=Lax` state cookie, and "post" for a cross-site form POST, which gives `None`). The outbound handler returns `trip.start(effect yielding { navigation, state }, ttl)`. The return handler returns `trip.back(request, (cookieState) => …)` and lands with `SessionDelivery.land(callbackURL, issued)`. The module sets `Referrer-Policy: no-referrer` on both legs, expires the state cookie on every return response, and answers a `postForm` navigation with a `no-store` page. Never set or expire a state cookie, or build a `text/html` response, by hand. The worked examples are `@awthaq/oauth` and `@awthaq/saml`.

    In `packages/server/README.md`, add a short `ReturnTrip` paragraph after the `SessionLifecycle` paragraph (`:60`) with the same content in two or three sentences, and add `ReturnTrip` to any module list in the README (grep for `SessionDelivery` to find it).

    In `spec/traceability.md` §5, add a row after the `SessionLifecycle.types.test.ts` row (`:255`): "`packages/server/test/ReturnTrip.test.ts` | Plan 33, PDR-004/CSS-001/CSS-006 (BEH-EA-122, BEH-EA-244, BEH-EA-315): a trip's state cookie is `__Host-` (type-enforced), `Secure; HttpOnly; Path=/`, no `Domain`, `SameSite=Lax` for a redirect return and `None` for a POST return, with the start's `Max-Age`; no cookie without state; `no-referrer` on both legs including a typed failure inside the caller's effect; the return leg hands back the cookie and expires it with identical attributes on success and failure; `navigate` answers `302` or a `no-store` page (REQ-EA-1544, 1545)". Bump Revision to 1.79 with a Change History entry naming plan 33's ticket 09.

    Create `.changeset/server-return-trip.md` with frontmatter `"@awthaq/server": minor` and `"@awthaq/oauth": patch`. Body: "`@awthaq/server` exports `ReturnTrip`: one module for a browser trip out to a provider and back (state cookie, no-referrer, navigation response); `@awthaq/oauth` uses it (no wire change)." Then: "Migration: none. A plugin with its own browser return trip replaces its hand-written state cookie, expiry and `Referrer-Policy` handler with `ReturnTrip.make`."
  </action>
  <verify><automated>pnpm spec:verify:strict && grep -q '^Migration:' .changeset/server-return-trip.md && grep -c 'ReturnTrip.make' docs/plugin-authoring.md</automated></verify>
  <acceptance_criteria>
    - `grep -c 'ReturnTrip.make' docs/plugin-authoring.md` is at least 1 (baseline at HEAD: 0).
    - `grep -c 'ReturnTrip' packages/server/README.md` is at least 1 (baseline at HEAD: 0).
    - `grep -c 'ReturnTrip.test.ts' spec/traceability.md` = 1 (baseline: 0); `grep -c -F '| Revision | 1.79 |' spec/traceability.md` = 1.
  </acceptance_criteria>
  <done>The module is documented and traced.</done>
</task>

<task type="auto">
  <name>Task 2: re-measure the count gates and run the plan gate</name>
  <files>(none edited unless a gate fails: then fix in the file the gate names)</files>
  <read_first>.planning/33-browser-return-trip/PLAN.md section 2.1</read_first>
  <action>
    Re-run C1–C10 from PLAN.md §2.1. The expected results:
    - C1–C5: `0` for both plugin files.
    - C6: `0`. C7: `0`. C8: `4`. C9: `5`.
    - C10: both files present.
    - `grep -c -F 'setCookie(' packages/server/src/ReturnTrip.ts` = 1 and `grep -c -F 'expireCookie(' packages/server/src/ReturnTrip.ts` = 1.

    Record the actual numbers and the line counts of `OAuth.ts` and `Saml.ts` in PLAN.md's "Decisions taken" section. Then run the plan gate. `pnpm test:pg` is not needed (no SQL adapter changed).
  </action>
  <verify><automated>pnpm check</automated></verify>
  <acceptance_criteria>
    - Every count matches the expected value; any mismatch is fixed or explained in "Decisions taken".
    - `pnpm check` exits 0 (knip: only `.reports/` entries).
  </acceptance_criteria>
  <done>Plan 33 is complete and its measurable targets (PLAN.md §5) are recorded.</done>
</task>
</tasks>

<verification>
pnpm check
</verification>

<success_criteria>
`pnpm check` is green. C1–C10 are at their targets and recorded. Plugin authors are pointed at `ReturnTrip` and `SessionDelivery.land`.
</success_criteria>

## Comments
