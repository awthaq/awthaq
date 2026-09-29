# Slice 11-frontend-next-react-client — validation & fix plan

- **Validated at:** `ec065a7` (HEAD, branch main) · **Date:** 2026-09-29 · **Issues:** 50 (packages/next, packages/react, packages/client)
- Machine-readable twin: `.plan/slices/11-frontend-next-react-client.json`

## Counts (verdict × level)

| Verdict | high | medium | low | info | total |
|---|---|---|---|---|---|
| CONFIRMED | 4 | 9 | 10 | 1 | 24 |
| PARTIAL | 1 | 2 | 3 | 0 | 6 |
| ALREADY-FIXED | 1 | 2 | 0 | 0 | 3 |
| INVALID | 0 | 0 | 0 | 1 | 1 |
| DUPLICATE | 0 | 8 | 2 | 2 | 12 |
| WONTFIX-CANDIDATE | 0 | 1 | 1 | 2 | 4 |
| **total** | 6 | 22 | 16 | 6 | 50 |

## What is really wrong in this area

The frontend packages ship real code, but the pieces do not compose safely. In `@awthaq/react`, `QadiProvider` builds its own registry inside `Providers`' outer one. The subject is therefore read from a registry that app mutations never invalidate (EAR-001). It also comes from a second fetch that is never gated on the session, so sign-out neither clears it nor closes gates in the same render (EAR-002). The module also has no `"use client"` (RSC-002). Since 409334e wired `CsrfProtection` onto every mutating group, the client side is behind in two ways. `CsrfClientLive` sends an empty header on a cold start (CDS-007). Worse, `ReactAuthClient` never provides the CSRF client middleware at all, and `AtomHttpApi` casts that requirement away, so its mutations 403 (**new finding NF-11-1**). In `@awthaq/next`, the ticket-16 rotation fix is incomplete: `applyRotatedSession` is not exported (RRS-002 / NF-11-2). The server-to-client seam also does not exist. `getSession`'s shapes cannot become `Providers` seeds, which are also non-serializable class instances (RSC-005 / NF-11-4), and `Providers` cannot accept hydrated qadi decisions (RSC-006). The documented server-action recipe is a placeholder that now 403s (BO-002/NSA-008). The rest is manifest hygiene (a phantom `@awthaq/react` dependency, reported 5×), an error-erasing Promise facade, and stale docs. Three findings are already fixed: PDR-002 and EHA-003 by 409334e (CSRF attachment), and MM-001 by 387838f (bun wildcard export). One is invalid: seeded SSR does not produce a hydration mismatch (EAR-005). Four are wontfix candidates (BO-004, BO-010, BO-007, PCS-007).

## Workstreams

### React Providers: client boundary, single registry, session-gated subject — `react-provider-subject-pipeline`

- **IDs:** RSC-002, EAR-003, EAR-001, EAR-002, RSC-004, EAR-006, EAR-004, EAR-005
- **Why grouped:** All touch Providers.tsx/AuthClientAtom.ts and the same subject-derivation pipeline; EAR-001 (registry shadowing) and EAR-002 (subject not gated on session) must be redesigned together, and EAR-004's live-path tests are the TDD drivers for both.
- **Order hint:** 1 · **Effort:** L · **Depends on workstreams:** —
- **Ordered steps:**
  1. Write EAR-004's fetch stub + failing live-path tests (anonymous, invalidation-flip, sign-out window, 500⇒Failure).
  2. RSC-002: add "use client" to Providers.tsx and index.ts; add the SSR renderToString/hydrateRoot test.
  3. EAR-002: add derived `subjectAtom` gated on sessionAtom (pure registry tests first).
  4. EAR-001: drop the outer RegistryProvider; seed via QadiProvider initialValues computed once with useState; add SubjectSync (useAtomSubscribe → registry.set(atoms.subject)).
  5. EAR-006: authStatusAtom + useAuthStatus + onError prop; delete render-phase console.error.
  6. Update header comments and spec/traceability.md rows; run spec:verify:strict.
- **Test plan:** packages/react/test/Providers.test.tsx (live-path scenarios); packages/react/test/SubjectAtom.test.ts; packages/react/test/Providers.ssr.test.tsx; packages/react/test/ClientBoundary.test.ts
- **Acceptance:** One registry under Providers; session-keyed mutation flips useSubject without remount. Signed-out/refetching session ⇒ subject undefined in the same render. Providers is a client module; SSR+hydrate produces no recoverable errors. No ECONNRESET in react test runs.

### @awthaq/next manifest: drop phantom @awthaq/react, declare next peer — `next-package-manifest-hygiene`

- **IDs:** BO-003, DESS-004, MTS-002, ERAS-005, NSA-007, NSA-005
- **Why grouped:** Five findings on the same unused dependency (+ knip mask + false description) and one on the missing next peer range — one manifest edit.
- **Order hint:** 1 · **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Remove @awthaq/react from dependencies, tsconfig paths/references, knip ignore.
  2. Reword description.
  3. Add optional `next >=15` peer; README note for middleware.ts on < 16.3.
  4. Changeset.
- **Test plan:** pnpm knip (without ignore); pnpm run typecheck; pnpm package:smoke
- **Acceptance:** No @awthaq/react edge from next; knip clean.

### CSRF client bootstrap now that CsrfProtection is live — `csrf-client-bootstrap`

- **IDs:** CDS-007, DESS-009, PDR-002, EHA-003
- **Why grouped:** 409334e activated CsrfProtection on every mutating group; the client half still sends an empty header on a cold start and the client source still claims CSRF is dormant.
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. Failing Csrf.test.ts scenarios (header omitted when no cookie; retry-once after 403).
  2. CsrfClientLive: omit header when cookie absent, retry once on CsrfRejected when a fresh cookie appeared; `CsrfClient.layer({ bootstrapRetry })`.
  3. Rewrite doc comments; delete stale 'no group declares CsrfProtection' comments (AuthClient.ts:27-35, index.ts:10-12).
  4. Factor `csrfClientLayer(readCookie)` so @awthaq/next (BO-002) can reuse it with a header-based cookie reader.
- **Test plan:** packages/client/test/Csrf.test.ts
- **Acceptance:** Cold-start mutation succeeds without app code handling 403. No stale CSRF-dormant comments remain.

### @awthaq/next getSession/withNextCookies correctness and test hygiene — `next-getsession-hardening`

- **IDs:** RRS-002, RSC-007, NSA-006, ETVS-006
- **Why grouped:** Small, independent correctness fixes in GetSession.ts/WithNextCookies.ts and their tests; RRS-002's residual is that the ticket-16 delivery helper is not exported.
- **Order hint:** 2 · **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. ETVS-006 first (per-case runtimes + dispose) so later tests are order-independent.
  2. RRS-002: export applyRotatedSession; import tests from ../src/index.ts; fix README imports.
  3. RSC-007: Effect.all for findById/resolve with a deadlock-detecting test.
  4. NSA-006: verbatim value + NaN/Invalid Date guards.
- **Test plan:** packages/next/test/GetSession.test.ts; packages/next/test/HasSessionCookie.test.ts; packages/next/test/WithNextCookies.test.ts
- **Acceptance:** `import { applyRotatedSession } from "@awthaq/next"` compiles. Next tests pass under --sequence.shuffle.

### Error-honest Promise facade — `client-promise-facade-errors`

- **IDs:** EHA-005, DESS-003
- **Why grouped:** Both findings: PromiseFacade erases E.
- **Order hint:** 2 · **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Failing runtime + type-level tests for result mode.
  2. Add ResultFacade type and `{ mode: "result" }` overload via Effect.result.
  3. Document both modes.
- **Test plan:** packages/client/test/AuthClient.test.ts
- **Acceptance:** Result-mode failure type equals the endpoint error union.

### @awthaq/react dependency topology — `react-package-deps`

- **IDs:** DESS-006, BO-007, MM-001
- **Why grouped:** Context-owning libs must be peers to avoid duplicate React contexts; wildcard-bun export already gone; star re-export stays (BEH-EA-184).
- **Order hint:** 2 · **Effort:** S · **Depends on workstreams:** —
- **Ordered steps:**
  1. Move @qadi/react, @qadi/core, @effect/atom-react (and effect) to peerDependencies (+devDependencies).
  2. Provenance table in README (with DESS-001).
- **Test plan:** pnpm package:smoke; react tests
- **Acceptance:** Single resolvable copy of qadi/atom-react in consumers.

### Server→client seam: RSC-safe seeds and server-decided gates — `next-react-ssr-bridge`

- **IDs:** RSC-005, EAR-007, RSC-006
- **Why grouped:** getSession's server shapes cannot reach Providers (wrong shape AND non-serializable class instances), and Providers cannot accept hydrated qadi decisions — the two halves of BEH-EA-177/185/186/192 never meet.
- **Order hint:** 3 · **Effort:** L · **Depends on workstreams:** react-provider-subject-pipeline, next-package-manifest-hygiene
- **Ordered steps:**
  1. Hoist a public `toSessionDto` into @awthaq/server/Session.ts; replace the 3 private copies.
  2. @awthaq/next `toInitialSession` returning encoded plain JSON.
  3. Providers accepts Encoded seeds and decodes; add `decisions` + `initialValues` props wired through hydrateDecisions.
  4. README: layout.tsx seeding recipe + server-side decide/dehydrate recipe.
- **Test plan:** packages/next/test/Seed.test.ts; packages/react/test/Providers.test.tsx (encoded seeds, BEH-EA-192 first paint)
- **Acceptance:** A Server Component can seed Providers without serialization errors. Server-decided Can renders its verdict on first paint.

### Generic reactive client over the composed api (CSRF, baseUrl, focus revalidation) — `react-client-atoms-factory`

- **IDs:** BE-004, CWM-005, FAMS-008, PCS-007
- **Why grouped:** The reactive layer only covers AuthCoreApi, hard-codes transport (no baseUrl, no CSRF — NF-11-1), and never revalidates; one factory fixes all three and turns org/plugin atoms into one-liners.
- **Order hint:** 3 · **Effort:** M · **Depends on workstreams:** csrf-client-bootstrap, react-provider-subject-pipeline
- **Ordered steps:**
  1. Interim NF-11-1 fix if this workstream is delayed: merge CsrfClientLive into ReactAuthClient's httpClient layer.
  2. makeReactClient factory (+ @awthaq/client dep); rebuild ReactAuthClient/ReactSubjectClient on it.
  3. Atom.refreshOnWindowFocus on raw session/subject queries (opt-out).
  4. README: org-switcher recipe, SESSION_KEY, session model.
- **Test plan:** packages/react/test/ReactClient.test.ts; Providers.test.tsx focus-revalidation scenario
- **Acceptance:** Typed atoms for every installed plugin from one call. Built-in mutations send x-csrf-token. Idle tab revalidates on focus.

### Typed in-process server-action client + runnable Next recipes — `next-server-action-facade`

- **IDs:** BO-002, IC-004, NSA-008, ERS-006, NSA-003
- **Why grouped:** The README's server-action recipe is a placeholder that now 403s under live CSRF; the fix is a typed HttpApiClient transport over the app's own handler (respecting the no-runtime-construction decision) plus README recipe corrections.
- **Order hint:** 4 · **Effort:** L · **Depends on workstreams:** csrf-client-bootstrap, client-promise-facade-errors, next-package-manifest-hygiene
- **Ordered steps:**
  1. Docs quick wins first (NSA-003 force-dynamic/imports, ERS-006 awaited bounded dispose, NSA-008 interim CSRF/cookie forwarding).
  2. Failing ServerActionClient tests (sign-in writes cookie; missing csrf ⇒ typed CsrfRejected; UA forwarded).
  3. Implement makeServerActionClient/serverActionClient over HttpApiClient with an in-process HttpClient transport + csrfClientLayer(headers reader) + withNextCookies harvesting.
  4. Replace README placeholder with the runnable recipe.
- **Test plan:** packages/next/test/ServerActionClient.test.ts
- **Acceptance:** README sign-in recipe has no placeholder and is test-backed. Typed client works from a server action for any composed api.

### Client bearer/native mode (token store + delivery header) — `client-native-bearer-mode`

- **IDs:** MNA-006
- **Why grouped:** Client half of decision ticket 17; blocked on server-side MNA-001.
- **Order hint:** 5 · **Effort:** M · **Depends on workstreams:** —
- **Ordered steps:**
  1. Wait for MNA-001 (server issues body token on X-Awthaq-Token-Delivery: bearer).
  2. TokenStore service + bearerTransform + bearerSignIn.
  3. RN recipe in client README.
- **Test plan:** packages/client/test/Bearer.test.ts
- **Acceptance:** Cookie-less client can authenticate end to end.

### Edge/proxy.ts stateless verification tier (decision needed) — `next-edge-stateless-tier`

- **IDs:** BO-006, ERAS-001, ERAS-003, BO-004, BO-010
- **Why grouped:** Presence-only proxy check is the sole edge primitive; the lite JWT verifier exists but is unexported and nothing mints an edge-verifiable cookie. Framework-hoisting (BO-004/010) parked until a second adapter is on the roadmap.
- **Order hint:** 6 · **Effort:** L · **Depends on workstreams:** —
- **Ordered steps:**
  1. Decide D1.
  2. If C: restore @awthaq/jwt ./verify export (NF-11-3); opt-in JWT mirror cookie in jwt; @awthaq/next/edge verifySessionJwt; BEH-EA-188 sub-requirement; README edge section (ERAS-003).
- **Test plan:** packages/next/test/Edge.test.ts; jwt slice: mirror-cookie tests
- **Acceptance:** proxy.ts can reject forged cookies without DB access; edge bundle imports no core/server.

### Truthful READMEs, descriptions, comments and migration notes — `frontend-docs-truthfulness`

- **IDs:** DESS-001, DESS-007, MTS-008, CWM-008, NAM-012
- **Why grouped:** Docs claim the packages are unimplemented, mislabel dependencies, cite stale versions, and omit the headless stance / next-auth migration shape. Best written after the API changes above settle.
- **Order hint:** 7 · **Effort:** M · **Depends on workstreams:** react-provider-subject-pipeline, react-client-atoms-factory, next-server-action-facade, next-react-ssr-bridge
- **Ordered steps:**
  1. MTS-008 comment fixes can land immediately.
  2. Rewrite client/react READMEs (DESS-001) incl. headless stance (CWM-008) and provenance table (DESS-006).
  3. Fix package descriptions (DESS-007).
  4. next README: next-auth migration section (NAM-012).
  5. package-smoke drift guard; refresh spec/behaviors 22-24 banners.
- **Test plan:** pnpm package:smoke drift check
- **Acceptance:** No README claims pre-implementation; all snippets use exported symbols.

## Decisions needed

### D1 — BO-006: No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired

- A — Won't fix: keep presence-only proxy.ts + DB-verified getSession (spec-compliant today); document the gap.
- B — Bearer-only edge helper: verify an `Authorization: Bearer <jwt>` header with the lite verifier (useful for API routes, useless for browser page navigations that only carry cookies).
- C — Opt-in JWT session-mirror cookie (jwt plugin) + `@awthaq/next/edge` `verifySessionJwt` helper; bounded revocation lag, never the boundary.

**Recommendation:** C — the richer, configurable option: it is the only one that helps real browser navigations at the edge, reuses the already-built lite verifier and PostAuthResponseHook, stays default-off, and keeps BEH-EA-188's boundary rule. Requires restoring @awthaq/jwt's `./verify` export first.

No other open decisions. Existing decisions followed, not re-litigated:
- Ticket 16: pure-RSC rotation stays a documented platform limit; `Sessions.verify` is not changed (RRS-002).
- `.scratch/next-package/spec.md`: no runtime construction or `globalThis`-pinning helper in `@awthaq/next` (IC-004). Decision hydration is app-level wiring from qadi exports (RSC-006 only adds a `Providers` input).
- Ticket 24: CSRF is on by default (EHA-003/PDR-002).

Implementation note (not open): BEH-EA-179 says a signed-out subject is `undefined`, so anonymous visitors' qadi gates stay pending. Allowing anonymous-permitted gates would need a spec amendment.

## New findings discovered during validation (not in the manifest)

### NF-11-1 — ReactAuthClient mutations silently omit the CSRF header and 403 against CSRF-guarded groups (high, workstream `react-client-atoms-factory`)

`packages/react/src/AuthClientAtom.ts:40` — No CsrfClientLive provided; AuthCoreApi = SessionGroup + AccountGroup, both `.middleware(CsrfProtection)` since 409334e (api/src/Session.ts:64, Account.ts:38).
```ts
    api: AuthCore.AuthCoreApi,
    httpClient: FetchHttpClient.layer,
```
`../effect/packages/effect/src/unstable/httpapi/HttpApiClient.ts:311` — A missing client middleware is skipped at runtime…
```ts
      const middleware = services.mapUnsafe.get(middlewareKeys[index]) as
        | HttpApiMiddleware.HttpApiMiddlewareClient<any, any, any>
        | undefined
      if (middleware === undefined) {
        return executeMiddleware(group, endpoint, request, middlewareKeys, index - 1)
```
`../effect/packages/effect/src/unstable/reactivity/AtomHttpApi.ts:212` — …and AtomHttpApi casts away the ForClient<CsrfProtection> requirement, so nothing type-checks it.
```ts
        Layer.provide(layer, options.httpClient) as Layer.Layer<Self>
```
**Fix:** Provide CsrfClientLive in ReactAuthClient's httpClient layer (done structurally by BE-004's makeReactClient; minimal interim fix: `httpClient: Layer.merge(FetchHttpClient.layer, AuthClient.CsrfClientLive)` + add @awthaq/client dep). Test: EAR-004 scenario (5).

### NF-11-2 — applyRotatedSession is not exported from @awthaq/next (high, workstream `next-getsession-hardening`)

`packages/next/src/index.ts:9` — Folded into RRS-002's plan.
```ts
export { getSession } from "./GetSession.ts";
```
**Fix:** See RRS-002.

### NF-11-3 — @awthaq/jwt's standalone makeVerifier is unreachable after the ./* export removal (cross-slice: jwt) (medium, workstream `next-edge-stateless-tier`)

`packages/jwt/src/index.ts:11` — verify.ts not exported; package.json exports only "." (387838f).
```ts
export * as Jwt from "./Jwt.ts";
export * as JwtApi from "./JwtApi.ts";
export * as JwtCodec from "./JwtCodec.ts";
```
**Fix:** Add a `./verify` subpath export to packages/jwt/package.json (keeps the lite verifier free of core/server). Prereq of BO-006 option C.

### NF-11-4 — Providers' initialSession/initialSubject are Schema.Class instances — not passable from a Server Component (medium, workstream `next-react-ssr-bridge`)

`packages/api/src/Session.ts:18` — Class instances are not serializable Client Component props; folded into RSC-005's plan (accept Encoded + decode).
```ts
export class SessionDto extends Schema.Class<SessionDto>("SessionDto")({
```
**Fix:** See RSC-005.

## Per-issue dossiers

### Workstream `react-provider-subject-pipeline`

#### EAR-001 — QadiProvider's inner registry shadows the outer one, so the subject prop can never update after mount

`high` · `correctness` · `react` · [.issues/high/EAR-001-effect-atom-react-specialist.md](../../.issues/high/EAR-001-effect-atom-react-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/react/src/Providers.tsx:103` — SubjectBridge (and its useAtomValue(subjectDtoAtom)) resolves against the OUTER registry.
  ```
    return (
      <RegistryProvider initialValues={initialValues}>
        <SubjectBridge atoms={atoms} instrument={instrument} initialValues={initialValues}>
          {children}
        </SubjectBridge>
      </RegistryProvider>
    );
  ```
- `node_modules/.pnpm/@qadi+react@0.7.0_react@19.3.0_scheduler@0.27.0/node_modules/@qadi/react/lib/QadiProvider.js:82` — QadiProvider builds its own registry and provides it (line 130 `RegistryContext.Provider, { value: registry …`) to children — so every mutation/invalidation run by app code under Providers hits the INNER registry; the outer subjectDtoAtom never refetches.
  ```
      const registryRef = useRef(undefined);
      const registry = (registryRef.current ??= AtomRegistry.make({
          initialValues: [
              [atoms.subject, subject],
              ...(initialValues ?? []),
          ],
      }));
  ```

**Fix plan** (effort M; depends on: RSC-002; spec: BEH-EA-177, BEH-EA-178, BEH-EA-179): Collapse to ONE registry: drop the outer RegistryProvider, seed everything through QadiProvider's initialValues, and derive/sync the qadi subject inside QadiProvider's registry from a new derived `subjectAtom` (implemented jointly with EAR-002).

Steps:
1. In `packages/react/src/AuthClientAtom.ts` add an exported derived `subjectAtom = Atom.make((get) => …)` returning `AuthSubject | undefined` (semantics defined in EAR-002's plan) — this is the single place the subject is derived.
2. Rewrite `packages/react/src/Providers.tsx`: remove `RegistryProvider` and the outer `SubjectBridge` read. Render `<QadiProvider atoms={atoms} subject={seededSubject} initialValues={seeds} instrument={instrument ?? false}><SubjectSync atoms={atoms} />{children}</QadiProvider>`.
3. Compute `seeds` (sessionAtom/subjectDtoAtom seed pairs, plus RSC-006's hydrated decisions later) and `seededSubject` ONCE with `useState(() => …)` — NOT per render. Reason: QadiProvider's resync effect (`if (registry.get(atoms.subject) !== subject) registry.set(atoms.subject, subject)`, QadiProvider.js:103-107) would otherwise overwrite the live subject with a freshly-allocated stale seed object on every parent re-render.
4. `SubjectSync` (new internal component, same file): `const registry = useContext(RegistryContext)` (from `@effect/atom-react/RegistryContext`, which inside QadiProvider IS the qadi registry) and `useAtomSubscribe(AuthClientAtom.subjectAtom, (s) => registry.set(atoms.subject, s), { immediate: true })` (`@effect/atom-react/Hooks` exports `useAtomSubscribe`). The write happens in the registry subscription, not a React effect, so gates re-decide in the same registry batch as the session change. Renders `null`.
5. Update the file header comment (lines 5-17) to describe the single-registry design and why (EAR-001).
6. No type assertions: `seed` helper at Providers.tsx:86 already produces typed tuples; keep it.

Files: `packages/react/src/Providers.tsx`, `packages/react/src/AuthClientAtom.ts`, `packages/react/test/Providers.test.tsx`

Tests:
- TDD first (fails at HEAD): `packages/react/test/Providers.test.tsx` — scenario "EAR-001: a session-keyed mutation under Providers flips useSubject without remount": stub `fetch` (vi.stubGlobal) so GET /session and GET /subject return user:1 first, then user:2; render `<Providers atoms initialSession initialSubject>` with a probe calling `useSubject()`, trigger `Reactivity` invalidation of key `session` from a child (e.g. `useAtomSet(ReactAuthClient.mutation("session","revokeOthers"))` called with `reactivityKeys: ["session"]`, or `Reactivity.invalidate` run via the inner registry), `await waitFor` probe text `user:2…`.
- Scenario "re-rendering Providers' parent does not reset the live subject to the seed": after the flip to user:2, re-render the parent with the same props and assert the probe still reads user:2.

Acceptance:
- Exactly one AtomRegistry exists under `<Providers>` (no RegistryProvider import remains in Providers.tsx).
- After a `["session"]`-keyed mutation, `useSubject()` under Providers reflects the refetched subject without remount (test above green).
- BEH-EA-178/179 feature text unchanged; traceability row for Providers.test.tsx in `spec/traceability.md` updated to mention the invalidation test; `pnpm run spec:verify:strict` green.

**Recommended status:** `ready-for-agent`

#### EAR-002 — Subject is derived from a second independent fetch, and after sign-out it is an anonymous AuthSubject rather than undefined

`high` · `compliance` · `react` · [.issues/high/EAR-002-effect-atom-react-specialist.md](../../.issues/high/EAR-002-effect-atom-react-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for RSC-004

**Evidence at HEAD:**

- `packages/react/src/Subject.ts:38` — Subject derives only from the subject DTO; sessionAtom is never consulted.
  ```
  export const toSubject = (dto: SubjectContract.SubjectDto | undefined): AuthSubject | undefined =>
    dto === undefined
      ? undefined
      : makeSubject({
  ```
- `packages/react/src/Providers.tsx:72` — Fed from subjectDtoAtom (GET /subject), which resolves an anonymous SubjectDto for signed-out callers (spec/traceability.md:189: `id: "anonymous"` for no credential) — never undefined after sign-out.
  ```
    const dto = AsyncResult.isSuccess(subjectResult) ? subjectResult.value : undefined;
  ```
- `spec/behaviors/23-react.md:63` — BEH-EA-179 requirement the code does not meet.
  ```
  REQUIREMENT: The React provider tree MUST derive qadi's `subject` prop from
               `sessionAtom`'s current value, not from a second, independently
               fetched source; when the session becomes `undefined` (sign-out),
               `subject` MUST become `undefined` in the same render.
  ```

**Fix plan** (effort M; depends on: EAR-001; spec: BEH-EA-179, BEH-EA-180): Gate the subject on sessionAtom: `subjectAtom` is undefined unless sessionAtom is a settled, non-waiting Success with a real session AND subjectDtoAtom is a settled, non-waiting Success. Keeps the separate /subject endpoint (Subject.ts / qadi SubjectApi.ts rationale) but makes sessionAtom the gate, closing the stale-grant window in the same registry batch.

Steps:
1. In `packages/react/src/AuthClientAtom.ts` define `export const subjectAtom = Atom.make((get) => { const s = get(sessionAtom); if (!AsyncResult.isSuccess(s) || s.waiting || s.value === null) return undefined; const d = get(subjectDtoAtom); if (!AsyncResult.isSuccess(d) || d.waiting) return undefined; return Subject.toSubject(d.value); })`. Import `toSubject` from `./Subject.ts` (no cycle: Subject.ts imports only @qadi/core and a type).
2. Because both atoms carry `reactivityKeys: ["session"]`, an invalidation marks both `waiting` in the same registry tick → subject collapses to `undefined` (gates render `pending`, per BEH-EA-180) until BOTH have settled against the new session. Sign-out → sessionAtom `success(null)` → subject `undefined`, satisfying BEH-EA-179 literally.
3. Wire `subjectAtom` into Providers via EAR-001's `SubjectSync`; `seededSubject` = `initialSession !== undefined && initialSubject !== undefined ? toSubject(initialSubject) : undefined` (a seeded subject without a seeded session is not trusted).
4. Rewrite the header comments in `Subject.ts` (lines 1-11) and `AuthClientAtom.ts` (lines 24-29, 90-96) to state the gating rule instead of the 'not an independently-chosen source' reframing.
5. Note for implementer (not an open decision — BEH-EA-179 is explicit): signed-out visitors get `subject: undefined`, so qadi gates stay `pending` for anonymous users. If anonymous-permitted gates are later wanted, that is a BEH-EA-179 spec amendment, not part of this fix.

Files: `packages/react/src/AuthClientAtom.ts`, `packages/react/src/Subject.ts`, `packages/react/src/Providers.tsx`, `packages/react/test/Providers.test.tsx`, `packages/react/test/SubjectAtom.test.ts (new)`

Tests:
- TDD first: `packages/react/test/SubjectAtom.test.ts` — pure registry tests (no React): (1) "session success(null) ⇒ subjectAtom undefined even when subjectDtoAtom holds a subject" (seed both via `AtomRegistry.make({ initialValues })`); (2) "session waiting ⇒ undefined"; (3) "both settled ⇒ AuthSubject with dto roles/permissions".
- `Providers.test.tsx` scenario "BEH-EA-179: sign-out closes every gate in the same render": seeded user:1, stub fetch so GET /session then 401s (→ success(null)); invalidate `session`; assert the useSubject probe reads `undefined` at the first render where the session probe reads `no-session` (single `waitFor` checking both texts together).
- BDD: `features/features/07-client-integration/23-react.feature` REQ-EA-506/507 stay @skip @unwired (harness ticket 36); no text change needed since the code now matches them.

Acceptance:
- For every render where the session probe shows `no-session` or `pending`, the subject probe shows `undefined`.
- No code path returns an anonymous AuthSubject to QadiProvider.
- `pnpm run test` / `typecheck` / `spec:verify:strict` green.

**Recommended status:** `ready-for-agent`

#### RSC-002 — Providers.tsx lacks "use client"; canonical RSC usage crashes on first hook call

`high` · `dx` · `react` · [.issues/high/RSC-002-react-server-components-auth-specialist.md](../../.issues/high/RSC-002-react-server-components-auth-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high) — canonical for EAR-003

**Evidence at HEAD:**

- `packages/react/src/Providers.tsx:1` — File opens with a comment, no "use client" directive; `grep -rln '"use client"' packages/*/src` returns nothing at HEAD.
  ```
  // @awthaq/react — Providers
  //
  // spec/behaviors/23-react.md, BEH-EA-177/178/179.
  ```
- `packages/react/src/Providers.tsx:58` — Hook call inside SubjectBridge, a component defined in this directive-less module.
  ```
    const subjectResult = useAtomValue(subjectDtoAtom);
  ```
- `node_modules/.pnpm/@qadi+react@0.7.0_react@19.3.0_scheduler@0.27.0/node_modules/@qadi/react/lib/QadiProvider.js:1` — Upstream modules carry the directive; awthaq's wrapper does not.
  ```
  "use client";
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-177): Mark every hook-bearing/client-only module of @awthaq/react as a client module and pin SSR behavior with a server-render test.

Steps:
1. Add `"use client";` as the very first line of `packages/react/src/Providers.tsx` (before the header comment).
2. Add `"use client";` to `packages/react/src/index.ts` as well: the barrel re-exports `@qadi/react` hooks and `Providers`, so an RSC importing `{ Providers }` from `@awthaq/react` gets a client reference rather than evaluating the module server-side. `AuthClientAtom.ts`/`Subject.ts` are hook-free and may stay directive-free, but the barrel must carry it.
3. Confirm `tsc -b` preserves the directive in `packages/react/lib/Providers.js`/`lib/index.js` (TS keeps leading string-literal prologues); if the build ever drops it, add a package-smoke assertion (`scripts/package-smoke.mjs`) that `lib/Providers.js` starts with `"use client"`.
4. Add an oxlint/grep-based repo check (or a unit test in `packages/react/test/`) that every `packages/react/src/*.tsx` file starts with `"use client"` so a new component module cannot regress this.

Files: `packages/react/src/Providers.tsx`, `packages/react/src/index.ts`, `scripts/package-smoke.mjs`, `packages/react/test/ClientBoundary.test.ts (new)`

Tests:
- TDD first: `packages/react/test/ClientBoundary.test.ts` — scenario "every client module starts with the use client directive": read `src/Providers.tsx` and `src/index.ts` and assert the first statement is `"use client"` (fails at HEAD).
- `packages/react/test/Providers.ssr.test.tsx` (new, `// @vitest-environment node` pragma or a separate vitest project) — scenario "seeded Providers renders on the server and hydrates without mismatch": `renderToString(<Providers atoms initialSession initialSubject>…)` then `hydrateRoot` in happy-dom with `onRecoverableError` spy asserting zero recoverable errors. This also pins EAR-005's (invalid) mismatch claim.

Acceptance:
- `head -1 packages/react/src/Providers.tsx` and `head -1 packages/react/lib/Providers.js` print `"use client";`.
- The SSR test renders seeded session/subject text server-side and hydrates with no recoverable error.
- `pnpm run typecheck`, `pnpm run test`, `pnpm package:smoke` green.

**Recommended status:** `ready-for-agent`

#### EAR-003 — No 'use client' directive in any packages/react source file

`medium` · `dx` · `react` · [.issues/medium/EAR-003-effect-atom-react-specialist.md](../../.issues/medium/EAR-003-effect-atom-react-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RSC-002**

**Evidence at HEAD:**

- `packages/react/src/Providers.tsx:1` — Same root cause as RSC-002 (no "use client" anywhere in packages/react/src); RSC-002 is the higher-severity canonical.
  ```
  // @awthaq/react — Providers
  ```

**No fix planned** — see evidence note (depends on RSC-002).

**Recommended status:** `resolved`

#### EAR-004 — Tests cover only the seeded path; the live fetch, invalidation, and failure paths are untested

`medium` · `testing` · `react` · [.issues/medium/EAR-004-effect-atom-react-specialist.md](../../.issues/medium/EAR-004-effect-atom-react-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/react/test/Providers.test.tsx:7` — Only 3 tests, all seeded.
  ```
  // second source" rest on, so these tests only exercise the seeded path
  // (`initialSession`/`initialSubject`), never the live query path (which
  // would need a real HTTP round trip to prove, `@awthaq/qadi`'s own
  ```
- `(test run) pnpm vitest run --project react:0` — Observed at HEAD: the unseeded test fires REAL fetches (no stub) — the live path is exercised accidentally and its failure is ignored.
  ```
  Error: socket hang up
    code: 'ECONNRESET'
   Test Files  1 passed (1)
        Tests  3 passed (3)
  ```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-177, BEH-EA-178, BEH-EA-179): Add a fetch-stubbed live-path suite; these tests are the TDD drivers for EAR-001/EAR-002/EAR-006 and the CSRF new finding.

Steps:
1. Add `packages/react/test/support/stubFetch.ts`: a tiny router over `vi.stubGlobal("fetch", …)` keyed on method+pathname returning `Response`s (JSON bodies encoded from `SessionContract.SessionDto`/`SubjectContract.SubjectDto` via `Schema.encodeSync`, 401 bodies for Unauthenticated). Restore in `afterEach`.
2. Tests: (1) anonymous first load: GET /session → 401 Unauthenticated ⇒ session probe `no-session` (covers `sessionAtom`'s translation at AuthClientAtom.ts:71-80); (2) invalidation flips subject without remount (EAR-001); (3) sign-out window (EAR-002); (4) 500 ⇒ Failure, not success(null); (5) ReactAuthClient mutation sends `x-csrf-token` (new finding NF-11-1).
3. Ensure no test leaves an unstubbed fetch (assert the stub saw every request; fail on unknown route) — removes the ECONNRESET noise.
4. Update the header comment of Providers.test.tsx and the `spec/traceability.md` row (line ~195) to list the new live-path coverage.

Files: `packages/react/test/support/stubFetch.ts (new)`, `packages/react/test/Providers.test.tsx`, `spec/traceability.md`

Tests:
- The scenarios listed in steps; each must be seen failing against HEAD (2, 3, 4-as-Failed, 5) before the corresponding fix lands.

Acceptance:
- `pnpm vitest run --project react` prints no ECONNRESET and covers anonymous, invalidation, sign-out, failure and CSRF-header paths.
- `pnpm run spec:verify:strict` green.

**Recommended status:** `ready-for-agent`

#### RSC-004 — BEH-EA-179's derive-subject-from-sessionAtom and same-render sign-out guarantee is not what shipped

`medium` · `correctness` · `react` · [.issues/medium/RSC-004-react-server-components-auth-specialist.md](../../.issues/medium/RSC-004-react-server-components-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **EAR-002**

**Evidence at HEAD:**

- `packages/react/src/AuthClientAtom.ts:97` — Same BEH-EA-179 deviation EAR-002 (high) already covers; RSC-004's option (b) — gate on sessionAtom — is exactly EAR-002's plan.
  ```
  export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
    reactivityKeys: ["session"],
  });
  ```

**No fix planned** — see evidence note (depends on EAR-002).

**Recommended status:** `resolved`

#### EAR-006 — Fetch failure is reported with a render-phase console.error and is otherwise indistinguishable from loading

`low` · `dx` · `react` · [.issues/low/EAR-006-effect-atom-react-specialist.md](../../.issues/low/EAR-006-effect-atom-react-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/react/src/Providers.tsx:65` — Render-phase side effect; no retry, no typed status exposed.
  ```
    if (AsyncResult.isFailure(subjectResult)) {
      console.error(
        "[@awthaq/react] subjectDtoAtom failed to resolve — QadiProvider will see `subject: undefined` " +
          "(indistinguishable from still-loading) until it succeeds:",
        subjectResult.cause,
      );
    }
  ```

**Fix plan** (effort M; depends on: EAR-002; spec: BEH-EA-179, BEH-EA-180): Replace the render-phase console.error with an exported auth-status atom/hook plus an optional `onError` prop and a retry handle.

Steps:
1. In `AuthClientAtom.ts` export `authStatusAtom = Atom.make((get) => …)` returning a tagged union `{ _tag: "Pending" } | { _tag: "SignedOut" } | { _tag: "Ready", subject } | { _tag: "Failed", cause }` derived from sessionAtom + subjectDtoAtom (Failure of either, excluding the Unauthenticated→null translation, ⇒ Failed).
2. Export `useAuthStatus()` from a new `packages/react/src/Hooks.ts` ("use client"): returns the status plus `retry = useAtomRefresh(subjectDtoAtom)` combined with a refresh of the raw session query.
3. Add optional `onError?: (cause: Cause.Cause<unknown>) => void` to `ProvidersProps`; inside `SubjectSync` use `useAtomSubscribe(authStatusAtom, …)` to call it once per transition into Failed (not per render). Default when absent: a single `console.error` from that subscription (dev-visible, not repeated under StrictMode).
4. Delete the render-phase block at Providers.tsx:59-71.
5. Export the new hook from `src/index.ts`.

Files: `packages/react/src/Providers.tsx`, `packages/react/src/AuthClientAtom.ts`, `packages/react/src/Hooks.ts (new)`, `packages/react/src/index.ts`

Tests:
- TDD first: `Providers.test.tsx` scenario "a 500 from /subject surfaces as Failed via useAuthStatus and calls onError exactly once": stub fetch → 500; spy `onError`; render in `<StrictMode>`; assert status probe `Failed`, `onError` called once, `console.error` not called during render.
- Scenario "retry() refetches and recovers": second stubbed response 200 → probe becomes `Ready`.

Acceptance:
- A persistent subject failure is distinguishable from loading through a public hook.
- No console output is produced during render.
- Retry path works without remount.

**Recommended status:** `ready-for-agent`

#### EAR-005 — Seeded SSR props guarantee a hydration mismatch in the guarded subtree

`info` · `correctness` · `react` · [.issues/info/EAR-005-effect-atom-react-specialist.md](../../.issues/info/EAR-005-effect-atom-react-specialist.md) · current status `needs-triage`

**Verdict:** INVALID (confidence medium)

**Evidence at HEAD:**

- `node_modules/.pnpm/@effect+atom-react@4.0.0-rc.116_effect@4.0.0-rc.116_react@19.3.0_scheduler@0.27.0/node_modules/@effect/atom-react/src/Hooks.ts:46`
  ```
      getServerSnapshot() {
        return Atom.getServerValue(atom, registry)
      }
  ```
- `../effect/packages/effect/src/unstable/reactivity/Atom.ts:2582` — Neither sessionAtom (Atom.make) nor subjectDtoAtom (AtomHttpApi query) carries a ServerValue override (grep of AtomHttpApi.ts finds none), so the server snapshot is `registry.get(atom)`.
  ```
    <A>(self: Atom<A>, registry: Registry.AtomRegistry): A =>
      ServerValueTypeId in self
        ? (self as any)[ServerValueTypeId]((atom: Atom<any>) => registry.get(atom))
        : registry.get(self)
  ```
- `node_modules/.pnpm/@effect+atom-react@4.0.0-rc.116_effect@4.0.0-rc.116_react@19.3.0_scheduler@0.27.0/node_modules/@effect/atom-react/src/RegistryContext.ts:86` — RegistryProvider seeds initialValues at construction during the SERVER render too — so server and client both read the seeded value; no mismatch for the seeded flow. RSC-002's planned renderToString+hydrateRoot test pins this.
  ```
    if (ref.current === null) {
      ref.current = {
        registry: AtomRegistry.make({
          scheduleTask: options.scheduleTask ?? scheduleTask,
          initialValues: options.initialValues,
  ```

**No fix planned** — see evidence note.

**Recommended status:** `wontfix`

### Workstream `next-package-manifest-hygiene`

#### BO-003 — @awthaq/next declares an unused @awthaq/react dependency

`medium` · `architecture` · `next` · [.issues/medium/BO-003-balazs-orban.md](../../.issues/medium/BO-003-balazs-orban.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for DESS-004, MTS-002, ERAS-005, NSA-007

**Evidence at HEAD:**

- `packages/next/package.json:27` — `grep -rn "awthaq/react" packages/next/src packages/next/test` → no import.
  ```
    "dependencies": {
      "@awthaq/api": "workspace:*",
      "@awthaq/core": "workspace:*",
      "@awthaq/react": "workspace:*",
      "@awthaq/server": "workspace:*",
  ```
- `packages/next/tsconfig.src.json:14` — Plus the project reference at :26 `"path": "../react/tsconfig.src.json"`.
  ```
        "@awthaq/react": ["../react/src/index.ts"],
  ```
- `knip.json:54` — Knip allowlist masking it (MTS-002).
  ```
      "packages/next": {
        "ignoreDependencies": ["@awthaq/react"]
  ```
- `packages/next/package.json:5` — NSA-007's description half: no hydration code in the package.
  ```
    "description": "Next.js adapter: server/client boundary, cookie forwarding, SSR decision hydration.",
  ```

**Fix plan** (effort S; depends on: —; spec: —): Remove the phantom @awthaq/react edge everywhere and make the description truthful.

Steps:
1. `packages/next/package.json`: delete `"@awthaq/react": "workspace:*"`; reword `description` to "Next.js adapter: database-verified getSession, optimistic proxy.ts cookie check, Set-Cookie bridging for server actions." (if RSC-006/RSC-005 later add a hydration helper to this package, extend the wording then).
2. `packages/next/tsconfig.src.json`: delete the `@awthaq/react` path (line 14) and its reference (lines 25-27).
3. `knip.json`: delete the `packages/next` `ignoreDependencies` entry (lines 54-56).
4. `pnpm install` to refresh the lockfile; add a changeset noting the dependency removal.
5. Do not hand-edit `packages/next/CHANGELOG.md` (changesets regenerates it).

Files: `packages/next/package.json`, `packages/next/tsconfig.src.json`, `knip.json`, `pnpm-lock.yaml`, `.changeset/*.md (new)`

Tests:
- No unit test; the gate is `pnpm knip` (must pass WITHOUT the ignore) plus `pnpm run typecheck`.

Acceptance:
- `grep -rn awthaq/react packages/next` finds only CHANGELOG history.
- `pnpm knip` and `pnpm run typecheck` green with the knip ignore removed.

**Recommended status:** `ready-for-agent`

#### DESS-004 — @awthaq/next declares an unused runtime dependency on @awthaq/react

`medium` · `dx` · `next` · [.issues/medium/DESS-004-developer-experience-sdk-specialist.md](../../.issues/medium/DESS-004-developer-experience-sdk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-003**

**Evidence at HEAD:**

- `packages/next/package.json:30` — Same unused dependency as BO-003.
  ```
      "@awthaq/react": "workspace:*",
  ```

**No fix planned** — see evidence note (depends on BO-003).

**Recommended status:** `resolved`

#### MTS-002 — packages/next declares unused @awthaq/react dependency and reference edge, masked by a knip allowlist

`medium` · `dx` · `next` · [.issues/medium/MTS-002-monorepo-tooling-specialist.md](../../.issues/medium/MTS-002-monorepo-tooling-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-003**

**Evidence at HEAD:**

- `packages/next/package.json:30` — Same unused dependency as BO-003.
  ```
      "@awthaq/react": "workspace:*",
  ```
- `knip.json:55` — Knip-ignore removal is included in BO-003's plan.
  ```
        "ignoreDependencies": ["@awthaq/react"]
  ```

**No fix planned** — see evidence note (depends on BO-003).

**Recommended status:** `resolved`

#### NSA-005 — No peerDependencies: zero declared compatibility range for next or react

`medium` · `api` · `next` · [.issues/medium/NSA-005-nextjs-server-actions-auth-specialist.md](../../.issues/medium/NSA-005-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/next/package.json:42` — FIXED part: a peerDependencies block now exists (react, added by 6055f62 for React.cache). STILL MISSING: any `next` range, and no README note on proxy.ts vs middleware.ts for < 16.3.
  ```
    "peerDependencies": {
      "react": ">=19.3.0"
    },
  ```

**Fix plan** (effort S; depends on: BO-003; spec: BEH-EA-188): Declare the Next.js range the recipes assume and document the proxy.ts/middleware.ts split.

Steps:
1. `packages/next/package.json`: add `"next": ">=15.0.0"` to `peerDependencies` (async `headers()`/`cookies()` are Next 15+) and `"peerDependenciesMeta": { "next": { "optional": true } }` — the source only uses structural types (HeadersLike/CookieJarLike), so non-Next hosts (tests, other frameworks) must not get a hard peer error.
2. `packages/next/README.md` proxy section: one line — "On Next < 16.3 put this in `middleware.ts` and export it as `middleware`."
3. Keep `react >=19.3.0` (React.cache use).

Files: `packages/next/package.json`, `packages/next/README.md`

Tests:
- `pnpm package:smoke` (publint) green; no unit test.

Acceptance:
- `peerDependencies.next` present and optional; README states the < 16.3 variant.

**Recommended status:** `ready-for-agent`

#### ERAS-005 — @awthaq/next declares an unused runtime dependency on @awthaq/react, widening the import closure

`low` · `performance` · `next` · [.issues/low/ERAS-005-edge-runtime-auth-specialist.md](../../.issues/low/ERAS-005-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-003**

**Evidence at HEAD:**

- `packages/next/package.json:30` — Same unused dependency as BO-003.
  ```
      "@awthaq/react": "workspace:*",
  ```

**No fix planned** — see evidence note (depends on BO-003).

**Recommended status:** `resolved`

#### NSA-007 — Unused @awthaq/react dependency and a package description promising unshipped decision hydration

`low` · `dx` · `next` · [.issues/low/NSA-007-nextjs-server-actions-auth-specialist.md](../../.issues/low/NSA-007-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-003**

**Evidence at HEAD:**

- `packages/next/package.json:5` — Both halves (unused dep + misleading description) are folded into BO-003's plan.
  ```
    "description": "Next.js adapter: server/client boundary, cookie forwarding, SSR decision hydration.",
  ```

**No fix planned** — see evidence note (depends on BO-003).

**Recommended status:** `resolved`

### Workstream `csrf-client-bootstrap`

#### PDR-002 — CsrfProtection is fully implemented and tested but attached to zero groups — CSRF layer is dormant

`high` · `security` · `client` · [.issues/high/PDR-002-philippe-de-ryck.md](../../.issues/high/PDR-002-philippe-de-ryck.md) · current status `ready-for-agent`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `409334e`

**Evidence at HEAD:**

- `packages/api/src/Session.ts:59` — 409334e 'Wire CsrfProtection onto every mutating production endpoint' attached it to Session, Account, Admin, Organization, Passkey x3 and Password groups.
  ```
    // CSS-001/CDS-001/APS-001/NHS-001/PIL-001/TMS-001: `CsrfProtection`
    // declared last (outermost, runs first — see `AuthorizedSubject.ts`'s
    // header on declaration order) so a forged request is rejected before
    // `Authentication` does any credential work.
    .middleware(Authentication)
    .middleware(CsrfProtection);
  ```
- `packages/password/src/PasswordApi.ts:261` — Also AdminApi.ts:116, OrganizationApi.ts:756, PasskeyApi.ts:265/293/319/357, Account.ts:38.
  ```
    .middleware(Api.CsrfProtection);
  ```
- `packages/client/src/AuthClient.ts:27` — The quoted evidence comment survives but is now FALSE — cleanup is folded into CDS-007's plan.
  ```
  // **BEH-EA-171's `{ csrf: false }` contract variant has nothing to build
  // against yet.** No plugin's `HttpApiGroup` in this repository currently
  // declares `.middleware(Api.CsrfProtection)` at all
  ```

**No fix planned** — see evidence note.

**Recommended status:** `resolved`

#### EHA-003 — CsrfProtection middleware attached to zero served groups: documented CSRF defense is dead code

`medium` · `security` · `client` · [.issues/medium/EHA-003-effect-http-api-specialist.md](../../.issues/medium/EHA-003-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `409334e`

**Evidence at HEAD:**

- `packages/api/src/Account.ts:35` — Same root cause as PDR-002/APS-001/CDS-001, fixed by 409334e (no composition-level default/`{csrf:false}` yet — tracked by decision ticket 24, outside this slice). Stale client comment cleanup is in CDS-007.
  ```
    // See Session.ts's identical comment: `CsrfProtection` declared last so
    // it runs first.
    .middleware(Authentication)
    .middleware(CsrfProtection);
  ```

**No fix planned** — see evidence note.

**Recommended status:** `resolved`

#### CDS-007 — CsrfClientLive sends an empty-string header when the cookie is absent, producing opaque first-request 403s

`low` · `dx` · `client` · [.issues/low/CDS-007-csrf-defense-specialist.md](../../.issues/low/CDS-007-csrf-defense-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for DESS-009

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:93` — Empty-string header when the cookie is absent.
  ```
  export const CsrfClientLive: Layer.Layer<HttpApiMiddleware.ForClient<Api.CsrfProtection>> =
    HttpApiMiddleware.layerClient(Api.CsrfProtection, ({ next, request }) =>
      next(
        HttpClientRequest.setHeader(
          request,
          Api.CSRF_HEADER_NAME,
          readCookie(Api.CSRF_COOKIE_NAME) ?? "",
  ```
- `packages/server/src/Csrf.ts:153` — Server mints the cookie via a pre-response handler (applies to the 403 too), then rejects at :180 — so a first unsafe request always 403s and a retry would succeed. No longer dormant: 409334e attached CsrfProtection to Session/Account/Admin/Organization/Passkey/Password groups (e.g. packages/password/src/PasswordApi.ts:261).
  ```
          if (!cookieIsValid) {
            const fresh = yield* mint(crypto, config.secret).pipe(Effect.orDie);
            yield* HttpApiBuilder.securitySetCookie(Api.CsrfCookie, fresh, {
  ```

**Fix plan** (effort M; depends on: —; spec: BEH-EA-170, BEH-EA-075, BEH-EA-078): Make CsrfClientLive self-bootstrapping: omit the header when no cookie is readable, and on a CsrfRejected response retry exactly once after the 403's Set-Cookie has landed; document the flow.

Steps:
1. In `CsrfClientLive` (AuthClient.ts:93-102): read the cookie; if `undefined`, send the request WITHOUT the header (`next(request)`), else set it.
2. Wrap `next(...)` so that when the response fails with `Api.CsrfRejected` AND `readCookie(Api.CSRF_COOKIE_NAME)` is now defined (browser stored the pre-response-handler cookie from the 403) AND the header sent was absent or different from the new cookie, re-issue once with the fresh header. Use `Effect.catchTag("CsrfRejected", …)`-style narrowing on the middleware's error (check `HttpApiMiddleware.layerClient`'s `next` error channel in ../effect `effect/unstable/httpapi/HttpApiMiddleware.ts`; if `next` surfaces raw responses instead, branch on status 403 + decoded `_tag`). No type assertions.
3. Make the retry opt-out-able via `CsrfClient.layer({ bootstrapRetry?: boolean })` (default true) with `CsrfClientLive = CsrfClient.layer()` kept as the default export (flexibility-over-complexity).
4. Rewrite the doc comment above `CsrfClientLive` to document: which responses mint `__Host-csrf` (any response through a CSRF-guarded group, including GET /session), why a cold first unsafe call may 403, and that the retry handles it.
5. Also delete the stale header comment at AuthClient.ts:27-35 and client/src/index.ts:10-12 claiming no group declares CsrfProtection (fixed by 409334e); rewrite BEH-EA-171 note to say `{ csrf: false }` is still unimplemented in `Auth.make` (per decision ticket 24).

Files: `packages/client/src/AuthClient.ts`, `packages/client/src/index.ts`, `packages/client/test/Csrf.test.ts`, `spec/traceability.md`

Tests:
- TDD first: `packages/client/test/Csrf.test.ts` scenario "no cookie ⇒ no x-csrf-token header is sent" (stub `document` via `globalThis` with no cookie; capture outgoing request through a test `HttpClient` layer; assert header absent — fails at HEAD, which sends "").
- Scenario "first unsafe call 403s, cookie appears, CsrfClientLive retries once and succeeds": test HttpClient returns 403 CsrfRejected while setting the fake document.cookie, then 200.
- Scenario "a second 403 is surfaced, not retried again".

Acceptance:
- A cold browser's first mutation succeeds without application code handling CsrfRejected.
- At most one retry per request.
- Stale 'no group declares CsrfProtection' comments are gone (`grep -rn "declares \`.middleware(Api.CsrfProtection)\` at all" packages` → empty).

**Recommended status:** `ready-for-agent`

#### DESS-009 — CsrfClientLive's empty-string header fallback will produce opaque 403s when activated

`info` · `dx` · `client` · [.issues/info/DESS-009-developer-experience-sdk-specialist.md](../../.issues/info/DESS-009-developer-experience-sdk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **CDS-007**

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:99` — Identical defect and recommended fix as CDS-007 (low > info). Its 'dormant' premise is outdated: CSRF was activated by 409334e.
  ```
          readCookie(Api.CSRF_COOKIE_NAME) ?? "",
  ```

**No fix planned** — see evidence note (depends on CDS-007).

**Recommended status:** `resolved`

### Workstream `next-getsession-hardening`

#### RRS-002 — Next.js RSC path rotates the session secret then discards the rotated token — undeliverable rotation hard-logs the user out

`high` · `correctness` · `next` · [.issues/high/RRS-002-refresh-token-rotation-specialist.md](../../.issues/high/RRS-002-refresh-token-rotation-specialist.md) · current status `ready-for-agent`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/next/src/GetSession.ts:90` — FIXED part (6055f62, BO-001/IC-001/NSA-001/RSC-003 via decision ticket 16): the rotated token is no longer discarded; it rides on `Session.rotated`.
  ```
      const { session, rotated } = yield* sessions.verify(Redacted.make(token));
      const user = yield* users.findById(session.userId);
      const principal = yield* resolver.resolve(session);
      return { principal, user, session, rotated: Option.getOrUndefined(rotated) };
  ```
- `packages/next/src/index.ts:9` — STILL BROKEN: `applyRotatedSession` (GetSession.ts:163) is NOT exported from the package entry, so the delivery channel the fix relies on is unreachable by consumers (README.md:131 imports it from "@awthaq/next" — would not compile). Only the test imports it via ../src.
  ```
  export { getSession } from "./GetSession.ts";
  export type { HeadersLike, Session } from "./GetSession.ts";
  export { hasSessionCookie } from "./HasSessionCookie.ts";
  export { withNextCookies } from "./WithNextCookies.ts";
  ```
- `packages/next/README.md:141` — ACCEPTED residual: pure-RSC rotation still happens and is undeliverable; decision ticket 16 explicitly rejected a read-only verify / grace window (core `Sessions.verify` untouched). Not re-litigated.
  ```
  A pure Server Component render has no mutable cookie jar at all — Next.js
  RSCs cannot set cookies under any circumstances — so a rotation that happens
  to land during a Server-Component-only render is a genuine platform
  limitation, not something this package can route around.
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-185): Finish the ticket-16 design: export `applyRotatedSession`, fix the README snippet, and test through the public entry.

Steps:
1. `packages/next/src/index.ts`: add `export { applyRotatedSession, getSession } from "./GetSession.ts";`.
2. `packages/next/test/GetSession.test.ts:25`: import `applyRotatedSession`/`getSession` from `../src/index.ts` (public surface), so a future export drop fails the suite.
3. `packages/next/README.md:127-138`: add the missing `import { cookies, headers } from "next/headers";` (snippet uses `headers()` without importing it).
4. Optionally add a knip/package-smoke assertion that every symbol the README imports from `@awthaq/next` exists in `lib/index.d.ts` (cheap doc-drift guard).

Files: `packages/next/src/index.ts`, `packages/next/test/GetSession.test.ts`, `packages/next/README.md`

Tests:
- TDD first: change the test import to `../src/index.ts` — typecheck (`pnpm run typecheck`, tsconfig.test.json) fails at HEAD with 'Module has no exported member applyRotatedSession'.

Acceptance:
- `import { applyRotatedSession } from "@awthaq/next"` type-checks.
- README snippets compile when pasted (imports complete).
- Pure-RSC limitation remains documented (unchanged, per ticket 16).

**Recommended status:** `ready-for-agent`

#### ETVS-006 — Next-package tests share one ManagedRuntime and mutate TestClock across test cases

`low` · `testing` · `next` · [.issues/low/ETVS-006-effect-testing-vitest-specialist.md](../../.issues/low/ETVS-006-effect-testing-vitest-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/test/GetSession.test.ts:40` — Module-level runtime shared by 5 cases, never disposed (also `rotationRuntime` at :63, shared by the two rotation cases which each adjust its clock).
  ```
  const runtime = ManagedRuntime.make(TestLayer);
  ```
- `packages/next/test/GetSession.test.ts:130` — Shared TestClock advanced by one case (line drifted from the audit's :102).
  ```
      await runtime.runPromise(TestClock.adjust(Duration.days(31)));
  ```
- `packages/next/test/HasSessionCookie.test.ts:48` — Fresh per test but never disposed.
  ```
      const runtime = ManagedRuntime.make(TestLayer);
  ```

**Fix plan** (effort S; depends on: —; spec: —): Per-case runtimes for clock-mutating cases and deterministic disposal everywhere.

Steps:
1. In `GetSession.test.ts`, replace the two module-level runtimes with a `withRuntime(layer, (rt) => …)` helper that builds a ManagedRuntime, runs the body, and `await rt.dispose()` in `finally`; use it in every case (the React.cache wrapper does not memoize outside a render, so per-case runtimes don't change semantics).
2. Same helper in `HasSessionCookie.test.ts`.
3. Alternatively use `@effect/vitest`'s `layer(...)` per describe for read-only cases; keep clock-advancing cases isolated.

Files: `packages/next/test/GetSession.test.ts`, `packages/next/test/HasSessionCookie.test.ts`

Tests:
- Run the file with `--sequence.shuffle` (vitest) several times — must pass every order.

Acceptance:
- `pnpm vitest run --project next --sequence.shuffle` green repeatedly; no undisposed runtimes.

**Recommended status:** `ready-for-agent`

#### NSA-006 — parseSetCookie percent-decodes values browsers would store verbatim, and NaN/Invalid Date options can reach the jar

`low` · `correctness` · `next` · [.issues/low/NSA-006-nextjs-server-actions-auth-specialist.md](../../.issues/low/NSA-006-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/src/WithNextCookies.ts:69` — Value is percent-decoded before being written into the jar.
  ```
    const value = (() => {
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    })();
  ```
- `packages/next/src/WithNextCookies.ts:82` — No NaN guard (and :89 `options.expires = new Date(raw);` no Invalid Date guard).
  ```
      if (key === "max-age" && raw !== undefined) {
        options.maxAge = Number(raw);
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-189): Pass the Set-Cookie value through verbatim and drop invalid numeric/date attributes.

Steps:
1. Before changing the decode, verify how Next's `ResponseCookies.set` serializes (it `encodeURIComponent`s? check `next/dist/compiled/@edge-runtime/cookies` stringifyCookie). If Next re-encodes on write, keep a decode that is the exact inverse; otherwise write `rawValue` verbatim. Document the chosen invariant in the parseSetCookie doc comment: `jar value === what the browser would have stored from the original Set-Cookie`.
2. Guard options: `const n = Number(raw); if (Number.isFinite(n)) options.maxAge = n;` and `const d = new Date(raw); if (!Number.isNaN(d.getTime())) options.expires = d;`.

Files: `packages/next/src/WithNextCookies.ts`, `packages/next/test/WithNextCookies.test.ts`

Tests:
- TDD: `WithNextCookies.test.ts` scenarios "Max-Age=abc is dropped, not NaN", "Expires=garbage is dropped", "a %-containing value round-trips to the same wire bytes" (assert via a jar fake that re-serializes the way Next's ResponseCookies does).

Acceptance:
- No NaN/Invalid Date reaches `jar.set`.
- Round-trip test green.

**Recommended status:** `ready-for-agent`

#### RSC-007 — getSession resolves three services strictly sequentially in the RSC hot path

`low` · `performance` · `next` · [.issues/low/RSC-007-react-server-components-auth-specialist.md](../../.issues/low/RSC-007-react-server-components-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/src/GetSession.ts:90` — findById and resolver.resolve are independent after verify but run sequentially.
  ```
      const { session, rotated } = yield* sessions.verify(Redacted.make(token));
      const user = yield* users.findById(session.userId);
      const principal = yield* resolver.resolve(session);
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-185): Run the two post-verify lookups concurrently.

Steps:
1. Replace lines 91-92 with `const [user, principal] = yield* Effect.all([users.findById(session.userId), resolver.resolve(session)], { concurrency: "unbounded" });` — keep the existing `Effect.catchTags` (UserNotFound still collapses to `undefined`).
2. Keep the `verifyCached` React.cache wrapper unchanged.

Files: `packages/next/src/GetSession.ts`, `packages/next/test/GetSession.test.ts`

Tests:
- TDD: add scenario "resolves user and principal concurrently" using a `Users` test layer whose `findById` blocks on a `Deferred` that the `PrincipalResolver` test layer completes — deadlocks (times out) when sequential, passes when concurrent. Existing BEH-EA-185 cases must stay green.

Acceptance:
- Test above green; `getSession` semantics unchanged for all existing cases.

**Recommended status:** `ready-for-agent`

### Workstream `client-promise-facade-errors`

#### DESS-003 — toPromiseFacade silently discards the typed error channel

`medium` · `dx` · `client` · [.issues/medium/DESS-003-developer-experience-sdk-specialist.md](../../.issues/medium/DESS-003-developer-experience-sdk-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **EHA-005**

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:218` — Same finding as EHA-005; the recommended runPromiseExit/Result variant is EHA-005's plan.
  ```
        return (...args: ReadonlyArray<unknown>) => Effect.runPromise(value(...args));
  ```

**No fix planned** — see evidence note (depends on EHA-005).

**Recommended status:** `resolved`

#### EHA-005 — toPromiseFacade types away the shared error taxonomy at the Promise boundary

`medium` · `dx` · `client` · [.issues/medium/EHA-005-effect-http-api-specialist.md](../../.issues/medium/EHA-005-effect-http-api-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for DESS-003

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:188` — Error type erased.
  ```
  export type PromiseFacade<A> = A extends AnyClientMethod
    ? (...args: Parameters<A>) => Promise<Effect.Success<ReturnType<A>>>
    : A extends Readonly<Record<string, unknown>>
      ? { readonly [K in keyof A]: PromiseFacade<A[K]> }
      : A;
  ```
- `packages/client/src/AuthClient.ts:218` — Rejects with the typed error at runtime (test AuthClient.test.ts:127-138) but the type says nothing.
  ```
        return (...args: ReadonlyArray<unknown>) => Effect.runPromise(value(...args));
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-176, BEH-EA-172): Keep the rejecting facade (documented) and add an error-honest `mode: "result"` variant whose methods resolve `Result<A, E>` with E the endpoint's contract error union.

Steps:
1. Add `export type ResultFacade<A>`: same recursion as `PromiseFacade` but methods return `Promise<Result.Result<Effect.Success<ReturnType<A>>, Effect.Error<ReturnType<A>>>>` (`effect/Result`).
2. Add overloads: `toPromiseFacade(client)` (unchanged) and `toPromiseFacade(client, { mode: "result" }): ResultFacade<A>`; implementation wraps with `Effect.runPromise(Effect.result(value(...args)))` in result mode (Effect.result exists in ../effect Effect.ts:2275). Keep the overload-vs-implementation split already used (no casts).
3. Document on `toPromiseFacade`: default mode rejects with the tagged contract error (switch on `error._tag`, cf. `ErrorCodes<Api>`); result mode is the typed alternative. Mention defects (network/decoding) still reject in both modes.
4. Export a tiny `isTagged(error, tag)` guard? — not needed; `Result.isFailure` + `_tag` narrowing suffices.

Files: `packages/client/src/AuthClient.ts`, `packages/client/test/AuthClient.test.ts`, `spec/traceability.md`

Tests:
- TDD: `AuthClient.test.ts` "result mode resolves Failure with the typed error" (runtime) plus a type-level assertion in the file's existing idiom (`Csrf.test.ts`/`ErrorCodes.test.ts` style): the failure type of `facade.password.signIn` equals `BoomFailure`.
- "result mode resolves Success with the value".

Acceptance:
- A non-Effect caller can `switch (result.failure._tag)` with exhaustiveness checking.
- BEH-EA-176 still holds (same generated methods, `Effect.runPromise` shim).

**Recommended status:** `ready-for-agent`

### Workstream `react-package-deps`

#### MM-001 — Exports wildcard bun condition cannot resolve .tsx files (react Providers)

`medium` · `dx` · `react` · [.issues/medium/MM-001-mattia-manzati.md](../../.issues/medium/MM-001-mattia-manzati.md) · current status `needs-triage`

**Verdict:** ALREADY-FIXED (confidence high) — fixed by `387838f`

**Evidence at HEAD:**

- `packages/react/package.json:14` — The `./*` wildcard with `bun: ./src/*.ts` was deleted from all packages by 387838f (AVS-001); the root bun entry `./src/index.ts` re-exports `./Providers.tsx`, which Bun resolves.
  ```
    "exports": {
      ".": {
        "types": "./lib/index.d.ts",
        "bun": "./src/index.ts",
        "import": "./lib/index.js",
        "default": "./lib/index.js"
      }
    },
  ```

**No fix planned** — see evidence note.

**Recommended status:** `resolved`

#### BO-007 — Wildcard re-export of @qadi/react leaks upstream renames into the public API

`low` · `api` · `react` · [.issues/low/BO-007-balazs-orban.md](../../.issues/low/BO-007-balazs-orban.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

**Evidence at HEAD:**

- `packages/react/src/index.ts:10` — The finding argues purely from upstream-rename/API-stability hazard; the library is pre-release, @qadi/react is the maintainer's own library (../qadi), and the standing preference is not to argue from API stability. The real residual risk (duplicate context instances) is handled by DESS-006's peerDependency plan.
  ```
  // BEH-EA-180 through 184 (`Can`/`Cannot`/`useCan`/`useInvalidate`/
  // `useProjected`/`useSubject`/`useDecision`/etc.) are `@qadi/react`'s own
  // exports, re-exported here verbatim — BEH-EA-184 explicitly forbids a
  // second, awthaq-specific evaluation shortcut
  ```

**No fix planned** — see evidence note (depends on DESS-006).

**Recommended status:** `wontfix`

#### DESS-006 — @awthaq/react star-re-exports the entire @qadi/react surface

`low` · `api` · `react` · [.issues/low/DESS-006-developer-experience-sdk-specialist.md](../../.issues/low/DESS-006-developer-experience-sdk-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

**Evidence at HEAD:**

- `packages/react/src/index.ts:19` — Verbatim re-export is mandated by BEH-EA-184's no-wrapper rule (index.ts:10-16) — provenance/discoverability complaint is a documentation matter.
  ```
  export * from "@qadi/react";
  ```
- `packages/react/package.json:27` — REAL part: @qadi/react / @effect/atom-react are hard dependencies, so an app that also installs @qadi/react (it must, to call makeQadiAtoms — or it imports it via the star) at a different version gets two QadiContext/RegistryContext instances.
  ```
    "dependencies": {
      "@awthaq/api": "workspace:*",
      "@effect/atom-react": "catalog:",
      "@qadi/core": "^0.7.0",
      "@qadi/react": "^0.7.0",
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-184): Make the context-owning libraries peers and document provenance.

Steps:
1. `packages/react/package.json`: move `@qadi/react`, `@qadi/core`, `@effect/atom-react` to `peerDependencies` (same ranges) and keep them in `devDependencies` for tests; `effect` likewise peer (catalog range).
2. README (DESS-001 rewrite): a provenance table — which exports are awthaq-owned (`Providers`, `AuthClientAtom.*`, `Subject.*`, `makeReactClient`, `useAuthStatus`) vs passthrough from `@qadi/react`.
3. Note: upstream qadi is at 0.8.0 (../qadi `git log` dd4d247) — bumping is a separate change.

Files: `packages/react/package.json`, `packages/react/README.md`, `pnpm-lock.yaml`

Tests:
- `pnpm package:smoke` (publint/attw) green; existing react tests green.

Acceptance:
- Only one copy of @qadi/react/@effect/atom-react can be resolved in a consuming app.

**Recommended status:** `ready-for-agent`

### Workstream `next-react-ssr-bridge`

#### RSC-005 — getSession's return struct is neither RSC-prop-safe nor Providers-compatible; no adapter bridges the two halves

`medium` · `api` · `next` · [.issues/medium/RSC-005-react-server-components-auth-specialist.md](../../.issues/medium/RSC-005-react-server-components-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for EAR-007

**Evidence at HEAD:**

- `packages/next/src/GetSession.ts:54` — SessionView carries DateTime.Utc/Option fields (packages/core/src/Sessions.ts:106-113).
  ```
  export interface Session {
    readonly principal: Api.Principal;
    readonly user: Users.UserRecord;
    readonly session: Sessions.SessionView;
  ```
- `packages/react/src/Providers.tsx:37` — Providers expects a SessionDto — a Schema.Class INSTANCE (packages/api/src/Session.ts:18), which React cannot pass from a Server Component to a Client Component (class instances are not serializable props). No mapper exists in next/react; three private identical `toSessionDto(SessionView)` copies live in password/admin/passkey (Password.ts:345, Admin.ts:110, Passkey.ts:203).
  ```
    readonly initialSession?: SessionContract.SessionDto | undefined;
  ```

**Fix plan** (effort M; depends on: EAR-001, BO-003; spec: BEH-EA-177, BEH-EA-185): Ship the missing server→client seam: a public SessionView→SessionDto mapper, a next-side helper that produces RSC-safe (encoded, plain JSON) seed props, and Providers accepting the encoded shape.

Steps:
1. `packages/server/src/Session.ts`: export `toSessionDto(view: Sessions.SessionView, current = true): SessionContract.SessionDto` (same body as Password.ts:345-353). Replace the three private copies in `packages/password/src/Password.ts`, `packages/admin/src/Admin.ts`, `packages/passkey/src/Passkey.ts` with it (cross-slice touch, mechanical).
2. `packages/next/src/Seed.ts` (new): `export const toInitialSession = (session: Session | undefined) => session === undefined ? undefined : Schema.encodeSync(SessionContract.SessionDto)(Session.toSessionDto(session.session))` — returns the plain `SessionDto.Encoded` object. Export from `src/index.ts`. (No return-type annotation needed on new consts; let inference.)
3. `packages/react/src/Providers.tsx`: widen `initialSession`/`initialSubject` to `typeof SessionContract.SessionDto.Encoded` / `typeof SubjectContract.SubjectDto.Encoded` and decode inside the `useState` initializer via `Schema.decodeUnknownSync(SessionContract.SessionDto)` (accepts both plain objects and instances — no assertions). A decode failure seeds nothing (falls back to the live query) and reports via EAR-006's `onError`.
4. Doc: in `GetSession.ts`'s `Session` doc comment state that `Session`/`SessionView`/`UserRecord` are server-only shapes and must go through `toInitialSession` before crossing to client props.
5. README (`packages/next/README.md`): add a 'Seeding @awthaq/react's Providers' section: `app/layout.tsx` (Server Component) → `const session = await getSession(await headers(), runtime)` → `<Providers atoms={atoms} initialSession={toInitialSession(session)} initialSubject={…}>`; initialSubject is produced by the app's own qadi `SubjectResolver.resolve(session.principal)` + `Schema.encodeSync(SubjectContract.SubjectDto)` (next stays off @awthaq/qadi per its own design note, GetSession.ts:13-20). Mention the router.refresh()/re-seed caveat: seeds apply only at first mount (RegistryProvider/QadiProvider build their registry once).

Files: `packages/server/src/Session.ts`, `packages/password/src/Password.ts`, `packages/admin/src/Admin.ts`, `packages/passkey/src/Passkey.ts`, `packages/next/src/Seed.ts (new)`, `packages/next/src/index.ts`, `packages/react/src/Providers.tsx`, `packages/next/README.md`

Tests:
- TDD first: `packages/next/test/Seed.test.ts` — "toInitialSession yields a JSON-round-trippable plain object": `JSON.parse(JSON.stringify(x))` deep-equals `x`, prototype is `Object.prototype`, and `expiresAt` equals the view's `absoluteExpiresAt` ISO string; "undefined in, undefined out".
- `packages/react/test/Providers.test.tsx` — "initialSession accepts the encoded plain object" (pass `Schema.encodeSync(SessionDto)(session)`).
- `packages/server/test/Session.test.ts` (or existing) — toSessionDto mapping test; existing password/admin/passkey tests must stay green.

Acceptance:
- A Server Component can pass `toInitialSession(await getSession(...))` to `<Providers>` without an RSC serialization error.
- Only one SessionView→SessionDto mapper remains in the repo (`grep -rn 'const toSessionDto' packages/*/src` → 0).
- `pnpm check` green.

**Recommended status:** `ready-for-agent`

#### RSC-006 — Server-decided gate seeding (BEH-EA-186/192) is unimplemented; first paint shows pending for every auth gate

`medium` · `architecture` · `react` · [.issues/medium/RSC-006-react-server-components-auth-specialist.md](../../.issues/medium/RSC-006-react-server-components-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/react/src/index.ts:19` — OVERSTATED part: `dehydrateDecisions`/`hydrateDecisions` DO exist and are re-exported through this star (qadi packages/react/src/Hydration.ts:205/346; installed @qadi/react 0.7.0 lib/index.d.ts `export * from "./Hydration.ts"`). The `.scratch/next-package/spec.md:236-245` decision says hydration is app-level wiring from those exports.
  ```
  export * from "@qadi/react";
  ```
- `packages/react/src/Providers.tsx:95` — CONFIRMED part: Providers has no `decisions`/extra-`initialValues` input and builds QadiProvider's initialValues itself, so an app using `@awthaq/react`'s Providers has NO way to feed hydrateDecisions output into QadiProvider — BEH-EA-192 is unreachable without abandoning Providers. The README worked example the next-package decision promised does not exist.
  ```
    const initialValues = [
      ...(initialSession === undefined
        ? []
        : [seed(sessionAtom, AsyncResult.success(initialSession))]),
      ...(initialSubject === undefined
        ? []
        : [seed(subjectDtoAtom, AsyncResult.success(initialSubject))]),
    ];
  ```

**Fix plan** (effort M; depends on: EAR-001, EAR-002, RSC-005; spec: BEH-EA-186, BEH-EA-192): Let Providers accept the server's dehydrated decisions (and arbitrary extra seeds), hydrate them against the seeded subject, and document the server half.

Steps:
1. `ProvidersProps`: add `readonly decisions?: DehydratedDecisions` (type from `@qadi/react`) and `readonly initialValues?: InitialValues` (escape hatch, merged last).
2. In the `useState` seed initializer (EAR-001): `const hydrated = decisions !== undefined && seededSubject !== undefined ? Array.from(hydrateDecisions(atoms, decisions, seededSubject)) : []` and append to the QadiProvider `initialValues` (BEH-EA-192's exact wiring). `hydrateDecisions` already drops a payload whose subjectId mismatches (qadi Hydration.ts:363-381) — no extra trust logic here.
3. `packages/next/README.md`: add the server half (BEH-EA-186/187/191): in the page's data-loading Effect resolve the subject once, `decide` each needed policy against attributes-only resources, `dehydrateDecisions(entries)`, pass `decisions` to Providers — consistent with the existing decision that hydration is app-level (no new next export).
4. Keep decisions JSON-serializable across the RSC boundary (they already are plain JSON per BEH-EA-186).

Files: `packages/react/src/Providers.tsx`, `packages/react/test/Providers.test.tsx`, `packages/next/README.md`

Tests:
- TDD first: `Providers.test.tsx` scenario "BEH-EA-192: a server-decided gate renders its verdict on first paint": build a policy with `@qadi/core`, dehydrate an Allow for subject user:1, render `<Providers atoms initialSession initialSubject decisions={…}><Can policy resource pending='pending'>granted</Can></Providers>` and assert the first render shows `granted` (no `pending`). Plus "a payload for another subject is dropped (renders pending)".

Acceptance:
- First paint of a server-decided `Can` is its verdict, not pending.
- Mismatched-subject payload is ignored.
- `spec/traceability.md` gains BEH-EA-192 coverage row; `spec:verify:strict` green.

**Recommended status:** `ready-for-agent`

#### EAR-007 — No integration joins packages/next's server session to Providers' initialSession prop

`info` · `architecture` · `next` · [.issues/info/EAR-007-effect-atom-react-specialist.md](../../.issues/info/EAR-007-effect-atom-react-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **RSC-005**

**Evidence at HEAD:**

- `packages/next/src/GetSession.ts:13` — Same missing next→Providers seam; examples/ holds only `memory-server` (no Next example). RSC-005's plan includes the mapper + README composition recipe.
  ```
  // Returns a 3-field struct, not `spec/overview.md`'s aspirational 4-field
  // `SessionView` (which also carries a qadi `subject`) — resolving a subject
  // stays the caller's own job
  ```

**No fix planned** — see evidence note (depends on RSC-005).

**Recommended status:** `resolved`

### Workstream `react-client-atoms-factory`

#### BE-004 — Reactive React client covers only the core session; plugin routes need hand-built clients

`medium` · `dx` · `react` · [.issues/medium/BE-004-bereket-engida.md](../../.issues/medium/BE-004-bereket-engida.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for CWM-005

**Evidence at HEAD:**

- `packages/react/src/AuthClientAtom.ts:37` — Fixed to AuthCoreApi; no baseUrl/transformClient option either (apps mounting auth under /api/auth or another origin cannot configure it).
  ```
  export class ReactAuthClient extends AtomHttpApi.Service<ReactAuthClient>()(
    "awthaq/react/ReactAuthClient",
    {
      api: AuthCore.AuthCoreApi,
      httpClient: FetchHttpClient.layer,
    },
  ) {}
  ```
- `packages/react/src/AuthClientAtom.ts:19` — Documented stance; every plugin needs a hand-built service.
  ```
  // Password's sign-in mutation) builds its own `AtomHttpApi.Service` directly
  // against its own composed `api`
  ```

**Fix plan** (effort M; depends on: CDS-007, EAR-001; spec: BEH-EA-169, BEH-EA-170, BEH-EA-178): Export a generic reactive-client factory over an app's composed `auth.api`, carrying CSRF + transport options, and rebuild the built-in session/subject atoms on it.

Steps:
1. New `packages/react/src/ReactClient.ts`: `export const makeReactClient = <Self>() => <const Id extends string, ApiId extends string, Groups extends HttpApiGroup.Constraint>(id: Id, options: { api: HttpApi.HttpApi<ApiId, Groups>; baseUrl?: string | URL; transformClient?: …; csrf?: boolean })` that calls `AtomHttpApi.Service<Self>()(id, { api, baseUrl, transformClient, httpClient: csrf === false ? FetchHttpClient.layer : Layer.merge(FetchHttpClient.layer, AuthClient.CsrfClientLive) })`. Class-style usage mirrors AtomHttpApi: `class AppClient extends makeReactClient<AppClient>()("app/Client", { api: auth.api }) {}` → `AppClient.query("organization","active", …)` / `AppClient.mutation("password","signIn")` fully typed from the composed api.
2. Add `@awthaq/client` as a dependency of `@awthaq/react` (makes the package description true, DESS-007) to reuse `CsrfClientLive`.
3. Rebuild `ReactAuthClient`/`ReactSubjectClient` with `makeReactClient` (keeps names/exports; CSRF now provided — closes NF-11-1 for the built-ins).
4. Export `sessionReactivityKeys = ["session"] as const`? — NO (`as const` is an assertion per the no-assertions rule); export `const SESSION_KEY = "session"` and document `reactivityKeys: [SESSION_KEY]` for session-changing mutations (sign-in, sign-out, setActive org, accept invite).
5. README (react): an 'Organization switcher' recipe (CWM-005): `AppClient.query("organization","active")` + `AppClient.mutation("organization","setActive")` called with `reactivityKeys: [SESSION_KEY]` + `useInvalidate()` per BEH-EA-181. Confirm endpoint names against `packages/organization/src/OrganizationApi.ts` when writing.

Files: `packages/react/src/ReactClient.ts (new)`, `packages/react/src/AuthClientAtom.ts`, `packages/react/src/index.ts`, `packages/react/package.json`, `packages/react/tsconfig.src.json`, `packages/react/README.md`

Tests:
- TDD: `packages/react/test/ReactClient.test.ts` — type-level: `makeReactClient` over a synthetic 2-group api exposes `query("g1","e")` with the right success type and rejects an unknown group at compile time (`// @ts-expect-error`); runtime: with fetch stubbed, a mutation on a CsrfProtection group sends `x-csrf-token` from `document.cookie`, and `baseUrl` prefixes the request URL.

Acceptance:
- One call over `auth.api` yields typed atoms for every installed plugin group.
- Built-in ReactAuthClient mutations send the CSRF header.
- `baseUrl` configurable.

**Recommended status:** `ready-for-agent`

#### CWM-005 — packages/react exposes no organization atoms — an app migrating Clerk's OrganizationSwitcher must hand-build its own reactive layer

`medium` · `dx` · `react` · [.issues/medium/CWM-005-clerk-workos-migration-specialist.md](../../.issues/medium/CWM-005-clerk-workos-migration-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BE-004**

**Evidence at HEAD:**

- `packages/react/src/AuthClientAtom.ts:19` — Same root cause (reactive layer covers only AuthCoreApi); BE-004's generic factory makes org atoms a one-liner and its plan includes the org-switcher recipe with reactivityKeys wiring.
  ```
  // Password's sign-in mutation) builds its own `AtomHttpApi.Service` directly
  // against its own composed `api`
  ```

**No fix planned** — see evidence note (depends on BE-004).

**Recommended status:** `resolved`

#### FAMS-008 — Client SDK session model has no Firebase-style token surface or proactive refresh

`low` · `dx` · `client` · [.issues/low/FAMS-008-firebase-auth-migration-specialist.md](../../.issues/low/FAMS-008-firebase-auth-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence medium)

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:165` — In-memory, per-tab, no revalidation.
  ```
  export const SessionStoreLive: Layer.Layer<SessionStore> = Layer.effect(
    SessionStore,
    Effect.gen(function* () {
      const state = yield* Ref.make(Option.none<Session>());
  ```
- `packages/react/src/AuthClientAtom.ts:45` — Only refetches on a tagged mutation — an idle tab never learns about expiry/revocation until it acts.
  ```
  const rawSessionAtom = ReactAuthClient.query("session", "current", {
    reactivityKeys: ["session"],
  });
  ```

**Fix plan** (effort S; depends on: BE-004, EAR-004; spec: BEH-EA-178, BEH-EA-174): Add opt-out window-focus revalidation of the session/subject queries and document the session model for Firebase/token-SDK migrants.

Steps:
1. Wrap `rawSessionAtom` and `subjectDtoAtom` with `Atom.refreshOnWindowFocus` (exists in ../effect Atom.ts:2150) — mirrors next-auth's refetchOnWindowFocus default. Expose opt-out via `makeReactClient` options (BE-004) `revalidateOnFocus?: boolean` (default true).
2. README (client + react): 'Session model' section — the httpOnly cookie is the persistence (no IndexedDB tokens), server-side rotation replaces client refresh loops (`touchEvery`), `useAtomValue(sessionAtom)` replaces `onAuthStateChanged`, bearer tokens for APIs are the native/bearer mode (MNA-006).

Files: `packages/react/src/AuthClientAtom.ts`, `packages/react/README.md`, `packages/client/README.md`

Tests:
- `packages/react/test/Providers.test.tsx` "focus revalidates the session": stub fetch (session → then 401), dispatch `window` `focus` (happy-dom), assert session probe flips to `no-session`.

Acceptance:
- An idle tab re-checks its session on focus.
- Session-model docs exist in both READMEs.

**Recommended status:** `ready-for-agent`

#### PCS-007 — Client-side decision invalidation is a disconnected model: reactivity keys, no server push

`info` · `dx` · `react` · [.issues/info/PCS-007-permission-caching-specialist.md](../../.issues/info/PCS-007-permission-caching-specialist.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

**Evidence at HEAD:**

- `packages/react/src/AuthClientAtom.ts:97` — Accurate description of the documented model (BEH-EA-178/181 put invalidation on the app); the recommended fix presupposes an SSE/WebSocket push channel that does not exist and is not on spec/roadmap.md — speculative infra. FAMS-008's focus revalidation narrows the staleness window meanwhile.
  ```
  export const subjectDtoAtom = ReactSubjectClient.query("subject", "current", {
    reactivityKeys: ["session"],
  });
  ```

**No fix planned** — see evidence note.

**Recommended status:** `wontfix`

### Workstream `next-server-action-facade`

#### BO-002 — No adapter surface: no route handlers, signIn, or signOut — README's own server-action example contains a placeholder

`medium` · `dx` · `next` · [.issues/medium/BO-002-balazs-orban.md](../../.issues/medium/BO-002-balazs-orban.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for IC-004

**Evidence at HEAD:**

- `packages/next/README.md:99` — Placeholder in the flagship recipe; `packages/next/src/index.ts` exports only getSession/hasSessionCookie/withNextCookies — no dispatch/signIn/signOut surface.
  ```
  export async function signIn(email: string, password: string) {
    const request = new Request("http://internal/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: { "content-type": "application/json" },
    });
    const { handler } = await runtime.runPromise(/* build your web handler from AppApi */);
  ```

**Fix plan** (effort L; depends on: CDS-007, EHA-005, BO-003; spec: BEH-EA-189, BEH-EA-190): Ship a typed, in-process server-action client: `HttpApiClient` over the app's own composed api whose transport dispatches to the app's web handler, forwards the action request's cookies/CSRF/origin/UA, and harvests Set-Cookie into Next's jar — so `client.password.signIn({...})` works for ANY composed plugin set. Respects the existing next-package decision (no runtime construction owned by the package: the app passes its handler/runtime).

Steps:
1. New `packages/next/src/ServerActionClient.ts`: `export const makeServerActionClient = <ApiId extends string, Groups extends HttpApiGroup.Any>(api: HttpApi.HttpApi<ApiId, Groups>, options: { readonly handler: (request: Request) => Promise<Response>; readonly headers: HeadersLike; readonly jar: CookieJarLike; readonly origin?: string })` returning an Effect of `HttpApiClient.Client<Groups, …>` built with `HttpApiClient.make(api, { baseUrl: options.origin ?? "http://internal" })` provided with a custom `HttpClient` layer (`HttpClient.make((request) => …)`) that: converts the HttpClientRequest to a web `Request` (`HttpClientRequest` → fetch init), copies the incoming action's `cookie`, `user-agent`, `x-forwarded-for` headers, echoes the `__Host-csrf` cookie value as `x-csrf-token` (satisfies double-submit in-process; `Sec-Fetch-Site`/`Origin` absent ⇒ siteCheck passes, Csrf.ts:117-133), calls `options.handler`, runs `withNextCookies(response, options.jar)`, and returns an `HttpClientResponse.fromWeb(request, response)`.
2. Provide the CSRF client middleware inside that layer (reuse `@awthaq/client`'s `AuthClient.CsrfClientLive` semantics but reading the cookie from `options.headers` rather than `document`) so the typed client's `ForClient<CsrfProtection>` requirement is discharged — add `@awthaq/client` as a dependency of `@awthaq/next` or factor a `csrfClientLayer(readCookie)` constructor into `@awthaq/client` (preferred: `AuthClient.csrfClientLayer((name) => string | undefined)`, with `CsrfClientLive = csrfClientLayer(readCookie)`).
3. Export a Promise convenience: `serverActionClient(api, options)` = `toPromiseFacade`-wrapped client (depends on EHA-005's typed facade so error tags survive).
4. README: replace lines 89-116 with a runnable recipe: build `handler` once next to the pinned runtime (`HttpRouter.toWebHandler` over `AuthHttp.layer`/the app's Layer, per the existing `globalThis` recipe), then `const client = await serverActionClient(AppApi, { handler, headers: await headers(), jar: await cookies() }); const result = await client.password.signIn({ payload: { email, password } });`. Show sign-out too.
5. Keep `withNextCookies` exported for callers who dispatch themselves.

Files: `packages/next/src/ServerActionClient.ts (new)`, `packages/next/src/index.ts`, `packages/client/src/AuthClient.ts`, `packages/next/package.json`, `packages/next/README.md`, `packages/next/test/ServerActionClient.test.ts (new)`

Tests:
- TDD first: `packages/next/test/ServerActionClient.test.ts` — scenario "signIn through the in-process client writes the session cookie into the jar": compose the Password plugin + CsrfProtectionLive via the same `HttpRouter.toWebHandler` pattern `WithNextCookies.test.ts`'s integration case uses, seed incoming headers with a valid `__Host-csrf` cookie, call `client.password.signIn`, assert the fake jar received `Api.SessionCookie.key`.
- Scenario "without a csrf cookie the call fails with CsrfRejected (typed), not a thrown opaque error".
- Scenario "user-agent/x-forwarded-for from the action request reach the handler" (assert via a probe endpoint).

Acceptance:
- The README sign-in recipe has no placeholder and is exercised by a test.
- A typed client for the app's composed api works from a server action with cookies bridged automatically.
- No ManagedRuntime is constructed by @awthaq/next.

**Recommended status:** `ready-for-agent`

#### IC-004 — No high-level facade: server actions hand-build synthetic Requests and bridge cookies themselves

`medium` · `dx` · `next` · [.issues/medium/IC-004-iain-collins.md](../../.issues/medium/IC-004-iain-collins.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-002**

**Evidence at HEAD:**

- `packages/next/README.md:100` — Same missing facade as BO-002. IC-004's additional ask — a globalThis-pinning runtime helper — is explicitly rejected by the existing decision in .scratch/next-package/spec.md:215-229 ('ships no ManagedRuntime.make call, no module-level singleton, and no globalThis-pinning helper'); followed, not re-litigated.
  ```
    const request = new Request("http://internal/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password }),
  ```

**No fix planned** — see evidence note (depends on BO-002).

**Recommended status:** `resolved`

#### NSA-003 — README page recipe drops the force-dynamic guard that every spec recipe includes

`medium` · `security` · `next` · [.issues/medium/NSA-003-nextjs-server-actions-auth-specialist.md](../../.issues/medium/NSA-003-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/README.md:79` — No `export const dynamic = "force-dynamic"`; also `redirect` is used without an import from next/navigation.
  ```
  export default async function Page() {
    const session = await getSession(await headers(), runtime);
    if (session === undefined) redirect("/sign-in");
  ```
- `spec/appendices/03-nextjs-ssr-decision-hydration.md:49` — The spec's own recipe includes it.
  ```
  export const dynamic = "force-dynamic"
  ```

**Fix plan** (effort S; depends on: —; spec: BEH-EA-185): Add the guard and a short caching note to the page recipe.

Steps:
1. README.md:73-87: add `export const dynamic = "force-dynamic";` and `import { redirect } from "next/navigation";`.
2. Add 3 sentences: session-derived pages must be dynamic; `headers()` makes a route dynamic implicitly but the explicit export survives refactors/PPR; never cache a shell containing session data.

Files: `packages/next/README.md`

Tests:
- Docs-only.

Acceptance:
- Page recipe matches spec/appendices/03 (force-dynamic present; imports complete).

**Recommended status:** `ready-for-agent`

#### ERS-006 — Next README dispose recipe drops the dispose promise and never drains in-flight work

`low` · `dx` · `next` · [.issues/low/ERS-006-effect-runtime-scheduler-specialist.md](../../.issues/low/ERS-006-effect-runtime-scheduler-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/README.md:38` — Dispose promise dropped; no drain.
  ```
  const make = () => {
    const made = ManagedRuntime.make(AppLayer);
    const dispose = () => void made.dispose();
    process.once("SIGINT", dispose);
    process.once("SIGTERM", dispose);
    return made;
  };
  ```

**Fix plan** (effort S; depends on: —; spec: —): Fix the recipe (the decision keeps runtime pinning as README-only, so the fix is documentation).

Steps:
1. Rewrite README.md:38-46: `const dispose = async () => { await Promise.race([made.dispose(), new Promise((r) => setTimeout(r, 10_000))]); process.exit(0); };` with `process.once("SIGTERM", () => void dispose())`, and a short paragraph: ManagedRuntime.dispose closes the Layer scope (pools, finalizers) — await it before exit; bound it so a stuck finalizer can't hang shutdown.
2. Mention that `runtime.runPromise` fibers are not children of the runtime scope; for draining in-flight actions, wrap them via a small `inflight` counter shown in the recipe (optional block).
3. Also guard against double registration under dev HMR: register signal handlers only inside `make()` (already true) — state it.

Files: `packages/next/README.md`

Tests:
- Docs-only; no automated test.

Acceptance:
- Recipe awaits `dispose()` with a bounded timeout; no `void made.dispose()` remains.

**Recommended status:** `ready-for-agent`

#### NSA-008 — Server-action recipe dispatches a synthetic request with no forwarded context (cookies, origin, client metadata)

`low` · `dx` · `next` · [.issues/low/NSA-008-nextjs-server-actions-auth-specialist.md](../../.issues/low/NSA-008-nextjs-server-actions-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence high)

**Evidence at HEAD:**

- `packages/next/README.md:100` — CONFIRMED (and now worse than 'latent'): PasswordGroup carries CsrfProtection since 409334e (PasswordApi.ts:261), so this recipe's POST with no csrf cookie/header is rejected 403 today.
  ```
    const request = new Request("http://internal/sign-in", {
      method: "POST",
      body: JSON.stringify({ email, password }),
      headers: { "content-type": "application/json" },
    });
  ```
- `packages/password/src/Password.ts:866` — OVERSTATED: session ip/userAgent metadata is lost regardless of the recipe — no handler passes `request` metadata to `Sessions.issue` (Sessions.ts:171/373-374 accept it). That is a server-side gap outside this slice.
  ```
          const issued = yield* sessions.issue({ userId: user.id }).pipe(Effect.orDie);
  ```

**Fix plan** (effort S; depends on: BO-002; spec: BEH-EA-189, BEH-EA-077): Forward the action's context in the dispatch path (implemented inside BO-002's in-process client) and fix the README until that lands.

Steps:
1. Covered by BO-002 step 1 (cookie, UA, x-forwarded-for forwarding + csrf echo).
2. Interim README fix (can land before BO-002): show copying `cookie` from `await headers()` and setting `x-csrf-token` from `(await cookies()).get("__Host-csrf")?.value` on the synthetic Request, with a sentence explaining CSRF-guarded groups need the double-submit echo in-process.
3. Cross-slice note (not planned here): handlers should pass `request: { ip, userAgent }` into `Sessions.issue` — raise against the password/passkey/oauth slice.

Files: `packages/next/README.md`

Tests:
- Covered by BO-002's ServerActionClient tests (csrf echo + UA forwarding).

Acceptance:
- README recipe succeeds against a CSRF-guarded PasswordGroup.

**Recommended status:** `ready-for-agent`

### Workstream `client-native-bearer-mode`

#### MNA-006 — Client SDK assumes a browser cookie jar; no React Native story

`medium` · `dx` · `client` · [.issues/medium/MNA-006-mobile-native-auth-specialist.md](../../.issues/medium/MNA-006-mobile-native-auth-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:76` — Cookie-mode only; no token store / bearer seam.
  ```
  export const readCookie = (name: string): string | undefined => {
    const doc = Reflect.get(globalThis, "document");
    if (typeof doc !== "object" || doc === null) return undefined;
  ```
- `packages/client/src/AuthClient.ts:32` — Bearer mode is an undocumented one-liner; issuance side (MNA-001, decision ticket 17: opt-in `X-Awthaq-Token-Delivery: bearer`) is not implemented yet — `git log --grep=MNA-001` is empty.
  ```
  // variant to strip `CsrfProtection` middleware *from* today. A bearer-mode
  // client is, for now, simply `make(api, { baseUrl, transformClient })` with
  // no `CsrfClientLive` provided
  ```

**Fix plan** (effort M; depends on: MNA-001; spec: BEH-EA-171, BEH-EA-175): Ship a client-side bearer mode: a pluggable token-store service, a transformClient that attaches it, and the request header that opts into ticket 17's body token delivery; document the React Native recipe.

Steps:
1. `packages/client/src/Bearer.ts` (new): `class TokenStore extends Context.Service<TokenStore, { get: Effect<Option<Redacted<string>>>; set: (t: Redacted<string> | null) => Effect<void> }>()("awthaq/client/TokenStore")`, `TokenStore.layerMemory`, and `bearerTransform` = `HttpClient.mapRequestEffect` adding `Authorization: Bearer` from the store plus `X-Awthaq-Token-Delivery: bearer` (header name per decision ticket 17).
2. `bearerSignIn` helper: after a sign-in/passkey-verify response whose DTO carries `token` (added by MNA-001), `TokenStore.set` it.
3. Document in `packages/client/README.md`: RN recipe = `make(api, { baseUrl, transformClient: bearerTransform })` + a Keychain/Keystore-backed `TokenStore` layer written by the app (storage choice is the app's, per ticket 17), no `CsrfClientLive`; note BEH-EA-171's `{ csrf: false }` contract variant is still unimplemented (decision ticket 24) so today the bearer client still sees the CSRF requirement type and must satisfy it with a no-op layer — or wait for `Auth.make(plugins, { csrf: false })`.
4. Export from `packages/client/src/index.ts`.

Files: `packages/client/src/Bearer.ts (new)`, `packages/client/src/index.ts`, `packages/client/README.md`, `packages/client/test/Bearer.test.ts (new)`

Tests:
- TDD: `Bearer.test.ts` — "bearerTransform attaches Authorization from TokenStore and the delivery header"; "empty store ⇒ no Authorization header"; "bearerSignIn persists the body token" (against a stub HttpClient).

Acceptance:
- A non-browser client can sign in and call authenticated endpoints with no cookie jar (once MNA-001 lands).
- RN recipe documented.

**Recommended status:** `ready-for-agent`

### Workstream `next-edge-stateless-tier`

#### BO-004 — Framework-neutral adapter code lives in a Next-named package, stranding Astro/SvelteKit reuse

`medium` · `architecture` · `next` · [.issues/medium/BO-004-balazs-orban.md](../../.issues/medium/BO-004-balazs-orban.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

**Evidence at HEAD:**

- `packages/next/src/WithNextCookies.ts:110` — True that the code is framework-neutral, but spec/roadmap.md M5 lists only 'Next.js adapter' — no SvelteKit/Astro adapter is planned (`grep -rni 'sveltekit\|astro' spec/` → none). Hoisting into a new package now is speculative infra; the functions are already structural (HeadersLike/CookieJarLike) and can be hoisted when a second adapter is actually scheduled.
  ```
  export const withNextCookies = (response: Response, jar: CookieJarLike): void => {
  ```

**No fix planned** — see evidence note.

**Recommended status:** `wontfix`

#### BO-006 — No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired

`medium` · `architecture` · `next` · [.issues/medium/BO-006-balazs-orban.md](../../.issues/medium/BO-006-balazs-orban.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high) — canonical for ERAS-001

**Evidence at HEAD:**

- `packages/next/src/HasSessionCookie.ts:32` — Only proxy-safe primitive.
  ```
  export const hasSessionCookie = (request: { readonly headers: HeadersLike }): boolean =>
    hasCookie(request.headers.get("cookie"), Api.SessionCookie.key);
  ```
- `packages/jwt/src/verify.ts:76` — Standalone WebCrypto verifier exists — but is NOT reachable: packages/jwt/src/index.ts does not export verify.ts and 387838f removed the `./*` subpath (cross-slice gap).
  ```
  export const makeVerifier = (options: VerifierOptions) =>
    Effect.gen(function* () {
      const httpClient = yield* HttpClient.HttpClient;
  ```

**Fix plan** (effort L; depends on: —; spec: BEH-EA-188): (Pending decision D1) Add an optional stateless edge tier: an opt-in short-lived JWT session-mirror cookie minted by @awthaq/jwt, and an `@awthaq/next/edge` helper that verifies it with the lite verifier — documented as a better redirect signal, never the authorization boundary (BEH-EA-188 unchanged).

Steps:
1. Prereq (jwt slice): restore a public `./verify` subpath export in `packages/jwt/package.json` exporting `src/verify.ts` (keeps the lite verifier free of @awthaq/core/server).
2. @awthaq/jwt: `JwtConfig.sessionCookie?: { name: string; ttl: Duration }` (default off) — when on, the existing PostAuthResponseHook also sets a `__Host-`-prefixed, httpOnly, SameSite=Strict JWT cookie with `exp ≤ ttl` alongside the opaque session cookie; cleared on sign-out.
3. @awthaq/next: new subpath export `./edge` (`src/edge.ts`, imports only `@awthaq/api` + `@awthaq/jwt/verify` + `CookieHeader.ts`): `verifySessionJwt(request, verifier) => Promise<Claims | undefined>` — never throws, returns undefined on missing/invalid/expired.
4. Spec: add a BEH-EA-188 sub-requirement (or new BEH id) stating the edge tier is an optimistic signal with bounded revocation lag, not the boundary; update `spec/behaviors/24-nextjs-ssr.md` and traceability.
5. README: proxy.ts recipe variant using `verifySessionJwt`, with the revocation-lag caveat; edge deployment guidance (ERAS-003).

Files: `packages/jwt/package.json`, `packages/jwt/src/JwtConfig.ts`, `packages/jwt/src/Jwt.ts`, `packages/next/src/edge.ts (new)`, `packages/next/package.json`, `packages/next/README.md`, `spec/behaviors/24-nextjs-ssr.md`, `spec/traceability.md`

Tests:
- TDD: `packages/next/test/Edge.test.ts` — "valid mirror JWT ⇒ claims", "forged/expired ⇒ undefined", "no cookie ⇒ undefined" (sign with @awthaq/jwt's KeyRing test keys, JWKS via a stub HttpClient). jwt slice: "sessionCookie mode sets and clears the mirror cookie".

Acceptance:
- proxy.ts can reject forged/expired cookies without a DB call.
- Edge bundle imports no @awthaq/core/@awthaq/server (verify with a package-smoke import-graph check).
- BEH text updated; `spec:verify:strict` green.

**Needs decision:** yes — see D1.

**Recommended status:** `ready-for-human`

#### ERAS-001 — No stateless JWT verification tier wired into @awthaq/next despite @awthaq/jwt shipping a purpose-built lite verifier

`medium` · `architecture` · `next` · [.issues/medium/ERAS-001-edge-runtime-auth-specialist.md](../../.issues/medium/ERAS-001-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** DUPLICATE (confidence high) — duplicate of **BO-006**

**Evidence at HEAD:**

- `packages/next/src/index.ts:9` — Same missing stateless tier as BO-006.
  ```
  export { getSession } from "./GetSession.ts";
  export type { HeadersLike, Session } from "./GetSession.ts";
  export { hasSessionCookie } from "./HasSessionCookie.ts";
  ```

**No fix planned** — see evidence note (depends on BO-006).

**Recommended status:** `resolved`

#### ERAS-003 — No edge/worker export conditions or edge deployment guidance anywhere

`low` · `docs` · `client` · [.issues/low/ERAS-003-edge-runtime-auth-specialist.md](../../.issues/low/ERAS-003-edge-runtime-auth-specialist.md) · current status `needs-triage`

**Verdict:** PARTIAL (confidence medium)

**Evidence at HEAD:**

- `packages/client/package.json:14` — OVERSTATED: edge bundlers (Vercel Edge/workerd) resolve `import`/`default` to the same WebCrypto-pure `lib/*.js`; `edge-light`/`worker` conditions pointing at the same files (or at `.ts` source, as proposed) add nothing / would break. CONFIRMED: no spec/README documents an edge deployment split (`grep -rni 'edge\|workers' spec/*.md packages/*/README.md` finds no deployment guidance).
  ```
    "exports": {
      ".": {
        "types": "./lib/index.d.ts",
        "bun": "./src/index.ts",
        "import": "./lib/index.js",
        "default": "./lib/index.js"
  ```

**Fix plan** (effort S; depends on: BO-006; spec: BEH-EA-188): Documentation only: an edge deployment section; no new export conditions.

Steps:
1. Add an 'Edge / proxy.ts deployment' section to `packages/next/README.md`: which exports are edge-safe (`hasSessionCookie`; `@awthaq/next/edge` once BO-006 lands), which require origin (`getSession`: Sessions/Users/SQL), and that `@awthaq/api`/`@awthaq/client` are runtime-neutral.
2. Optionally an ADR under `spec/decisions/` recording 'no edge-specific export conditions; edge/origin split by entry point' so the question does not recur.

Files: `packages/next/README.md`, `spec/decisions/ (optional new ADR)`

Tests:
- Docs-only.

Acceptance:
- README states the edge/origin split.

**Recommended status:** `ready-for-agent`

#### BO-010 — CookieJarLike does not structurally satisfy SvelteKit's Cookies.set (path required) — second-adapter fit untested

`info` · `api` · `next` · [.issues/info/BO-010-balazs-orban.md](../../.issues/info/BO-010-balazs-orban.md) · current status `needs-triage`

**Verdict:** WONTFIX-CANDIDATE (confidence medium)

**Evidence at HEAD:**

- `packages/next/src/WithNextCookies.ts:44` — SvelteKit-fit concern only matters for a second adapter (see BO-004); every awthaq cookie already sets path=/ (Sessions.ts:157). Revisit together with BO-004.
  ```
  export interface CookieJarLike {
    readonly set: (name: string, value: string, options?: CookieSetOptions) => unknown;
  }
  ```

**No fix planned** — see evidence note (depends on BO-004).

**Recommended status:** `wontfix`

### Workstream `frontend-docs-truthfulness`

#### DESS-001 — Client and React READMEs falsely claim the packages are pre-implementation

`high` · `docs` · `client` · [.issues/high/DESS-001-developer-experience-sdk-specialist.md](../../.issues/high/DESS-001-developer-experience-sdk-specialist.md) · current status `ready-for-agent`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/client/README.md:3` — Unchanged at HEAD though the package now also ships PasskeyClient (0441226).
  ```
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
  ```
- `packages/react/README.md:3` — Identical banner.
  ```
  > **This describes a planned package.** awthaq is pre-implementation (see [`../../spec/README.md`](../../spec/README.md)); no line of source in this package has shipped yet. This README states intent, not shipped behavior.
  ```

**Fix plan** (effort M; depends on: RSC-002, EAR-001, BE-004, EHA-005, CDS-007; spec: —): Rewrite both READMEs from the shipped modules and add a drift guard.

Steps:
1. `packages/client/README.md`: sections — Install; `make`/`group`/`urlBuilder` over the app's `auth.api`; cookie mode with `CsrfClientLive` (and the bootstrap-retry behavior from CDS-007); `ErrorCodes<typeof api>` for i18n; `SessionStore` hydrate semantics; `toPromiseFacade` (both modes, EHA-005); `PasskeyClient` ceremony helper; bearer/native mode (MNA-006); session model (FAMS-008).
2. `packages/react/README.md`: Providers (single registry, seeding with `toInitialSession`, `decisions`), `sessionAtom`/`subjectAtom`/`useAuthStatus`, `makeReactClient` (BE-004), which exports are passthrough from `@qadi/react` (DESS-006), and the headless stance (CWM-008).
3. Drift guard: extend `scripts/package-smoke.mjs` to fail when a package README contains 'no line of source in this package has shipped yet' while `src/` has > 1 non-index module. NOTE cross-slice: 20 other package READMEs carry the same banner (admin, api, core, jwt, oauth, passkey, password, server, …) — either rewrite them in the same change or make the check an allowlist that shrinks; coordinate with the orchestrator.
4. Also refresh the stale 'This file describes planned behavior. No code implementing it exists yet' banners in `spec/behaviors/22-client-effect.md`, `23-react.md`, `24-nextjs-ssr.md` (line 15/14) — code exists for these BEH ids.

Files: `packages/client/README.md`, `packages/react/README.md`, `scripts/package-smoke.mjs`, `spec/behaviors/22-client-effect.md`, `spec/behaviors/23-react.md`, `spec/behaviors/24-nextjs-ssr.md`

Tests:
- Drift check: run `pnpm package:smoke` — must fail against a README with the banner (verify by temporarily reverting one README locally), pass after rewrite.

Acceptance:
- No slice README claims pre-implementation.
- Every README code snippet uses only exported symbols.
- `pnpm package:smoke`, `spec:verify:strict` green.

**Recommended status:** `ready-for-agent`

#### DESS-007 — @awthaq/react's description claims integration with @awthaq/client that does not exist

`low` · `docs` · `react` · [.issues/low/DESS-007-developer-experience-sdk-specialist.md](../../.issues/low/DESS-007-developer-experience-sdk-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/react/package.json:5` — No @awthaq/client in dependencies (lines 27-33); no import.
  ```
    "description": "React provider glue over @awthaq/client, including QadiProvider integration.",
  ```
- `packages/react/src/index.ts:3` — Same claim in the barrel header.
  ```
  // React provider glue over @awthaq/client, including QadiProvider integration.
  ```

**Fix plan** (effort S; depends on: BE-004; spec: —): Make the claim true (BE-004 adds @awthaq/client as a real dependency for CsrfClientLive) or reword; fix the client package's own misleading description too.

Steps:
1. If BE-004 lands (recommended): keep the wording but make it accurate: "React bindings: reactive AtomHttpApi clients over the awthaq contract (CSRF via @awthaq/client), Providers with QadiProvider integration."
2. If BE-004 is deferred: reword to "React provider glue over the @awthaq/api contracts via effect's AtomHttpApi, including QadiProvider integration." in package.json:5 and index.ts:3.
3. `packages/client/package.json:5` and `src/index.ts:3` say "AtomHttpApi client and session atom" but the package has neither (plain HttpApiClient + SessionStore + PasskeyClient) — reword to "Effect HttpApiClient bindings for the awthaq contract: CSRF client middleware, error-code derivation, session store, Promise facade, passkey ceremony helper."

Files: `packages/react/package.json`, `packages/react/src/index.ts`, `packages/client/package.json`, `packages/client/src/index.ts`

Tests:
- No test; reviewed with DESS-001.

Acceptance:
- Descriptions match dependencies/exports.

**Recommended status:** `ready-for-agent`

#### MTS-008 — Prose comments still cite effect rc.115 after the catalog moved to rc.116

`low` · `docs` · `client` · [.issues/low/MTS-008-monorepo-tooling-specialist.md](../../.issues/low/MTS-008-monorepo-tooling-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/client/src/AuthClient.ts:17`
  ```
  // against this project's `effect@4.0.0-rc.115` — that reasoning no longer
  ```
- `packages/react/src/AuthClientAtom.ts:9` — Catalog is `effect: 4.0.0-rc.116` (pnpm-workspace.yaml:17). These two are the only rc.11x literals under packages/**/*.ts(x).
  ```
  // `effect@4.0.0-rc.115` dependency) — no external, v3-pinned
  ```

**Fix plan** (effort S; depends on: —; spec: —): Remove literal versions from prose and guard against recurrence.

Steps:
1. AuthClient.ts:13-25 and AuthClientAtom.ts:7-11: replace `effect@4.0.0-rc.115` with 'the catalog-pinned `effect`' (no literal). While there, update AuthClient.ts:21 '(M5, not yet built)' — @awthaq/react's reactive bindings are built.
2. Add to the rc-bump checklist (CONTRIBUTING.md or `.changeset` README): `grep -rnE 'rc\.[0-9]+' packages --include='*.ts' --include='*.tsx'` must be empty.

Files: `packages/client/src/AuthClient.ts`, `packages/react/src/AuthClientAtom.ts`, `CONTRIBUTING.md`

Tests:
- Docs-only; the grep is the check.

Acceptance:
- `grep -rnE 'rc\.[0-9]+' packages --include='*.ts' --include='*.tsx' | grep -v /lib/` → empty.

**Recommended status:** `ready-for-agent`

#### NAM-012 — Next.js middleware parity is deliberately weaker — hasSessionCookie verifies nothing

`low` · `security` · `next` · [.issues/low/NAM-012-nextauth-authjs-migration-specialist.md](../../.issues/low/NAM-012-nextauth-authjs-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/next/src/HasSessionCookie.ts:17` — Design is correct (BEH-EA-188); the migration warning lives only in the source header. No docs/ migration guide exists (`ls docs` → agents/, domain.md, issue-tracker.md, triage-labels.md).
  ```
  // renders; the real boundary is `GetSession.ts`'s `getSession`, which every
  // page and server action reached past `proxy.ts` must still call itself.
  // Treating a passing `hasSessionCookie` check as authentication is exactly
  ```

**Fix plan** (effort S; depends on: BO-002, RSC-005; spec: BEH-EA-185, BEH-EA-188): Add an Auth.js/next-auth migration note to the next README.

Steps:
1. `packages/next/README.md`: 'Migrating from next-auth' section — `export { auth as middleware }` does NOT map to `hasSessionCookie`; map it to proxy.ts presence redirect + `getSession` in every page/action/route handler; table of next-auth → awthaq equivalents (`auth()` → `getSession`, `signIn()` → BO-002's server-action client, `SessionProvider` → `Providers` + `toInitialSession`).
2. Optional lint: an oxlint `no-restricted-imports`-style rule is overkill — skip (doc is sufficient).

Files: `packages/next/README.md`

Tests:
- Docs-only.

Acceptance:
- Migration section present, explicitly warns presence-only ≠ verification.

**Recommended status:** `ready-for-agent`

#### CWM-008 — Deliberate zero-component UI stance is undocumented in the packages themselves — migration scoping relies on reading header comments

`info` · `docs` · `react` · [.issues/info/CWM-008-clerk-workos-migration-specialist.md](../../.issues/info/CWM-008-clerk-workos-migration-specialist.md) · current status `needs-triage`

**Verdict:** CONFIRMED (confidence high)

**Evidence at HEAD:**

- `packages/react/README.md:5` — Only README text; no statement of the headless (no drop-in components) stance anywhere in packages/*/README.md or spec/overview.md.
  ```
  Client. React provider glue over @awthaq/client, including QadiProvider integration.
  ```

**Fix plan** (effort S; depends on: DESS-001; spec: BEH-EA-183): State the headless positioning normatively.

Steps:
1. `packages/react/README.md` (in DESS-001's rewrite): a 'What this package does not ship' section — no sign-in/sign-up/user-button/org-switcher components, ever; apps build forms against typed contract errors (BEH-EA-183) and org screens via `makeReactClient` (BE-004).
2. `spec/overview.md` client row: one sentence recording the headless stance.

Files: `packages/react/README.md`, `spec/overview.md`

Tests:
- Docs-only.

Acceptance:
- Headless stance stated in README and overview.

**Recommended status:** `ready-for-agent`

## Closed without work

| ID | Level | Verdict | Reason | Evidence |
|---|---|---|---|---|
| DESS-003 | medium | DUPLICATE | duplicate of EHA-005 | `packages/client/src/AuthClient.ts:218` |
| PDR-002 | high | ALREADY-FIXED | fixed by 409334e | `packages/api/src/Session.ts:59` |
| EHA-003 | medium | ALREADY-FIXED | fixed by 409334e | `packages/api/src/Account.ts:35` |
| DESS-009 | info | DUPLICATE | duplicate of CDS-007 | `packages/client/src/AuthClient.ts:99` |
| IC-004 | medium | DUPLICATE | duplicate of BO-002 | `packages/next/README.md:100` |
| DESS-004 | medium | DUPLICATE | duplicate of BO-003 | `packages/next/package.json:30` |
| MTS-002 | medium | DUPLICATE | duplicate of BO-003 | `packages/next/package.json:30` |
| ERAS-005 | low | DUPLICATE | duplicate of BO-003 | `packages/next/package.json:30` |
| NSA-007 | low | DUPLICATE | duplicate of BO-003 | `packages/next/package.json:5` |
| EAR-007 | info | DUPLICATE | duplicate of RSC-005 | `packages/next/src/GetSession.ts:13` |
| BO-004 | medium | WONTFIX-CANDIDATE | no second framework adapter on the roadmap; hoisting now is speculative | `packages/next/src/WithNextCookies.ts:110` |
| BO-010 | info | WONTFIX-CANDIDATE | only matters with a second adapter (BO-004) | `packages/next/src/WithNextCookies.ts:44` |
| ERAS-001 | medium | DUPLICATE | duplicate of BO-006 | `packages/next/src/index.ts:9` |
| MM-001 | medium | ALREADY-FIXED | fixed by 387838f | `packages/react/package.json:14` |
| CWM-005 | medium | DUPLICATE | duplicate of BE-004 | `packages/react/src/AuthClientAtom.ts:19` |
| RSC-004 | medium | DUPLICATE | duplicate of EAR-002 | `packages/react/src/AuthClientAtom.ts:97` |
| PCS-007 | info | WONTFIX-CANDIDATE | needs a push channel that does not exist or appear on the roadmap; FAMS-008 narrows the window | `packages/react/src/AuthClientAtom.ts:97` |
| EAR-003 | medium | DUPLICATE | duplicate of RSC-002 | `packages/react/src/Providers.tsx:1` |
| EAR-005 | info | INVALID | server snapshot = registry.get(atom); RegistryProvider seeds during SSR too, so no mismatch | `node_modules/.pnpm/@effect+atom-react@4.0.0-rc.116_effect@4.0.0-rc.116_react@19.3.0_scheduler@0.27.0/node_modules/@effect/atom-react/src/Hooks.ts:46` |
| BO-007 | low | WONTFIX-CANDIDATE | argues from API stability; BEH-EA-184 mandates verbatim re-export; dual-instance risk handled by DESS-006 | `packages/react/src/index.ts:10` |

## Cross-slice notes

- NF-11-3: @awthaq/jwt src/verify.ts (makeVerifier) is unexported since 387838f — jwt slice.
- NSA-008 residual: no handler passes request ip/userAgent into Sessions.issue (Password.ts:866, Passkey.ts:832, OAuth.ts:853) — password/passkey/oauth slices.
- DESS-001 drift guard: 20 other package READMEs carry the same 'planned package' banner.
- RSC-005 hoists toSessionDto into @awthaq/server and replaces private copies in password/admin/passkey.
- MNA-006 is blocked by MNA-001 (server bearer delivery, decision ticket 17).
- PDR-002/EHA-003 share root cause with APS-001/CDS-001/NHS-001/PIL-001/TMS-001 (all fixed by 409334e); `{ csrf: false }` in Auth.make (decision ticket 24, BEH-EA-171/079) remains unimplemented.

## Verification gate for every workstream

`pnpm run typecheck` · `pnpm run test` · `pnpm run test:bdd` · `pnpm run spec:verify:strict` · `pnpm lint` · `pnpm knip` (full: `pnpm check`). Baseline at HEAD: `pnpm vitest run --project react --project next --project client` has 9 files and 61 tests passing, with ECONNRESET noise from the react suite's real fetches.
