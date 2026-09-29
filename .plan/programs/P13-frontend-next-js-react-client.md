# P13 — Frontend: Next.js, React, client

Phase 2 · 29 open issues to fix (5 high, 10 medium, 13 low, 1 info) · 20 closed by validation · ~78h summed per-issue estimate (upper bound) · 1 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `react-client-atoms-factory` — Generic reactive client over the composed api (CSRF, baseUrl, focus revalidation)

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~5h · depends on workstreams: `csrf-client-bootstrap`, `react-provider-subject-pipeline`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BE-004](../slices/11-frontend-next-react-client.md) | medium | dx | CONFIRMED | M | CDS-007, EAR-001 | Export a generic reactive-client factory over an app's composed `auth.api`, carrying CSRF + transport options, and rebuild the built-in session/subject atoms on it. |
| [FAMS-008](../slices/11-frontend-next-react-client.md) | low | dx | CONFIRMED | S | BE-004, EAR-004 | Add opt-out window-focus revalidation of the session/subject queries and document the session model for Firebase/token-SDK migrants. |

Closed by validation in this workstream: CWM-005 (DUPLICATE → BE-004), PCS-007 (WONTFIX-CANDIDATE)

## `next-getsession-hardening` — @awthaq/next getSession/withNextCookies correctness and test hygiene

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RRS-002](../slices/11-frontend-next-react-client.md) | high | correctness | PARTIAL | S | — | Finish the ticket-16 design: export `applyRotatedSession`, fix the README snippet, and test through the public entry. |
| [ETVS-006](../slices/11-frontend-next-react-client.md) | low | testing | CONFIRMED | S | — | Per-case runtimes for clock-mutating cases and deterministic disposal everywhere. |
| [NSA-006](../slices/11-frontend-next-react-client.md) | low | correctness | CONFIRMED | S | — | Pass the Set-Cookie value through verbatim and drop invalid numeric/date attributes. |
| [RSC-007](../slices/11-frontend-next-react-client.md) | low | performance | CONFIRMED | S | — | Run the two post-verify lookups concurrently. |

## `react-provider-subject-pipeline` — React Providers: client boundary, single registry, session-gated subject

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~17h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EAR-001](../slices/11-frontend-next-react-client.md) | high | correctness | CONFIRMED | M | RSC-002 | Collapse to ONE registry: drop the outer RegistryProvider, seed everything through QadiProvider's initialValues, and derive/sync the qadi subject inside QadiProvider's registry from a new derived `subjectAtom` (implemented jointly with EAR-002). |
| [EAR-002](../slices/11-frontend-next-react-client.md) | high | compliance | CONFIRMED | M | EAR-001 | Gate the subject on sessionAtom: `subjectAtom` is undefined unless sessionAtom is a settled, non-waiting Success with a real session AND subjectDtoAtom is a settled, non-waiting Success. Keeps the separate /subject endpoint (Subject.ts / qadi SubjectApi.ts rationale) but makes sessionAtom the gate, closing the stale-grant window in the same registry batch. |
| [RSC-002](../slices/11-frontend-next-react-client.md) | high | dx | CONFIRMED | S | — | Mark every hook-bearing/client-only module of @awthaq/react as a client module and pin SSR behavior with a server-render test. |
| [EAR-004](../slices/11-frontend-next-react-client.md) | medium | testing | CONFIRMED | M | — | Add a fetch-stubbed live-path suite; these tests are the TDD drivers for EAR-001/EAR-002/EAR-006 and the CSRF new finding. |
| [EAR-006](../slices/11-frontend-next-react-client.md) | low | dx | CONFIRMED | M | EAR-002 | Replace the render-phase console.error with an exported auth-status atom/hook plus an optional `onError` prop and a retry handle. |

Closed by validation in this workstream: EAR-003 (DUPLICATE → RSC-002), RSC-004 (DUPLICATE → EAR-002), EAR-005 (INVALID)

## `frontend-docs-truthfulness` — Truthful READMEs, descriptions, comments and migration notes

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~8h · depends on workstreams: `next-react-ssr-bridge`, `next-server-action-facade`, `react-client-atoms-factory`, `react-provider-subject-pipeline`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DESS-001](../slices/11-frontend-next-react-client.md) | high | docs | CONFIRMED | M | RSC-002, EAR-001, BE-004, EHA-005, CDS-007 | Rewrite both READMEs from the shipped modules and add a drift guard. |
| [DESS-007](../slices/11-frontend-next-react-client.md) | low | docs | CONFIRMED | S | BE-004 | Make the claim true (BE-004 adds @awthaq/client as a real dependency for CsrfClientLive) or reword; fix the client package's own misleading description too. |
| [MTS-008](../slices/11-frontend-next-react-client.md) | low | docs | CONFIRMED | S | — | Remove literal versions from prose and guard against recurrence. |
| [NAM-012](../slices/11-frontend-next-react-client.md) | low | security | CONFIRMED | S | BO-002, RSC-005 | Add an Auth.js/next-auth migration note to the next README. |
| [CWM-008](../slices/11-frontend-next-react-client.md) | info | docs | CONFIRMED | S | DESS-001 | State the headless positioning normatively. |

## `next-server-action-facade` — Typed in-process server-action client + runnable Next recipes

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~15h · depends on workstreams: `client-promise-facade-errors`, `csrf-client-bootstrap`, `next-package-manifest-hygiene`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BO-002](../slices/11-frontend-next-react-client.md) | medium | dx | CONFIRMED | L | CDS-007, EHA-005, BO-003 | Ship a typed, in-process server-action client: `HttpApiClient` over the app's own composed api whose transport dispatches to the app's web handler, forwards the action request's cookies/CSRF/origin/UA, and harvests Set-Cookie into Next's jar — so `client.password.signIn({...})` works for ANY composed plugin set. Respects the existing next-package decision (no runtime construction owned by the package: the app passes its handler/runtime). |
| [NSA-003](../slices/11-frontend-next-react-client.md) | medium | security | CONFIRMED | S | — | Add the guard and a short caching note to the page recipe. |
| [ERS-006](../slices/11-frontend-next-react-client.md) | low | dx | CONFIRMED | S | — | Fix the recipe (the decision keeps runtime pinning as README-only, so the fix is documentation). |
| [NSA-008](../slices/11-frontend-next-react-client.md) | low | dx | PARTIAL | S | BO-002 | Forward the action's context in the dispatch path (implemented inside BO-002's in-process client) and fix the README until that lands. |

Closed by validation in this workstream: IC-004 (DUPLICATE → BO-002)

## `next-edge-stateless-tier` — Edge/proxy.ts stateless verification tier (decision needed)

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~13h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BO-006](../slices/11-frontend-next-react-client.md) | medium | architecture | CONFIRMED ⚖️ decision | L | — | (Pending decision D1) Add an optional stateless edge tier: an opt-in short-lived JWT session-mirror cookie minted by @awthaq/jwt, and an `@awthaq/next/edge` helper that verifies it with the lite verifier — documented as a better redirect signal, never the authorization boundary (BEH-EA-188 unchanged). |
| [ERAS-003](../slices/11-frontend-next-react-client.md) | low | docs | PARTIAL | S | BO-006 | Documentation only: an edge deployment section; no new export conditions. |

Closed by validation in this workstream: ERAS-001 (DUPLICATE → BO-006), BO-004 (WONTFIX-CANDIDATE), BO-010 (WONTFIX-CANDIDATE)

## `next-package-manifest-hygiene` — @awthaq/next manifest: drop phantom @awthaq/react, declare next peer

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [BO-003](../slices/11-frontend-next-react-client.md) | medium | architecture | CONFIRMED | S | — | Remove the phantom @awthaq/react edge everywhere and make the description truthful. |
| [NSA-005](../slices/11-frontend-next-react-client.md) | medium | api | PARTIAL | S | BO-003 | Declare the Next.js range the recipes assume and document the proxy.ts/middleware.ts split. |

Closed by validation in this workstream: DESS-004 (DUPLICATE → BO-003), MTS-002 (DUPLICATE → BO-003), ERAS-005 (DUPLICATE → BO-003), NSA-007 (DUPLICATE → BO-003)

## `next-react-ssr-bridge` — Server→client seam: RSC-safe seeds and server-decided gates

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~8h · depends on workstreams: `next-package-manifest-hygiene`, `react-provider-subject-pipeline`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [RSC-005](../slices/11-frontend-next-react-client.md) | medium | api | CONFIRMED | M | EAR-001, BO-003 | Ship the missing server→client seam: a public SessionView→SessionDto mapper, a next-side helper that produces RSC-safe (encoded, plain JSON) seed props, and Providers accepting the encoded shape. |
| [RSC-006](../slices/11-frontend-next-react-client.md) | medium | architecture | PARTIAL | M | EAR-001, EAR-002, RSC-005 | Let Providers accept the server's dehydrated decisions (and arbitrary extra seeds), hydrate them against the seeded subject, and document the server half. |

Closed by validation in this workstream: EAR-007 (DUPLICATE → RSC-005)

## `client-promise-facade-errors` — Error-honest Promise facade

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EHA-005](../slices/11-frontend-next-react-client.md) | medium | dx | CONFIRMED | S | — | Keep the rejecting facade (documented) and add an error-honest `mode: "result"` variant whose methods resolve `Result<A, E>` with E the endpoint's contract error union. |

Closed by validation in this workstream: DESS-003 (DUPLICATE → EHA-005)

## `csrf-client-bootstrap` — CSRF client bootstrap now that CsrfProtection is live

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CDS-007](../slices/11-frontend-next-react-client.md) | low | dx | CONFIRMED | M | — | Make CsrfClientLive self-bootstrapping: omit the header when no cookie is readable, and on a CsrfRejected response retry exactly once after the 403's Set-Cookie has landed; document the flow. |

Closed by validation in this workstream: DESS-009 (DUPLICATE → CDS-007), PDR-002 (ALREADY-FIXED), EHA-003 (ALREADY-FIXED)

## `react-package-deps` — @awthaq/react dependency topology

Slices: [11-frontend-next-react-client](../slices/11-frontend-next-react-client.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [DESS-006](../slices/11-frontend-next-react-client.md) | low | api | PARTIAL | S | — | Make the context-owning libraries peers and document provenance. |

Closed by validation in this workstream: BO-007 (WONTFIX-CANDIDATE), MM-001 (ALREADY-FIXED)

