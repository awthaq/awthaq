# 07-WORLD-TABLE: the World classification

HEAD `006a9fa0` (the guard commit of plan 07-06), 2026-11-15. 31 Worlds: scaffolded 3, hand-wired 5, no-tail 23.

The machine copy of this table is the inline map in `features/features/_guard/world-table.steps.test.ts`. The guard reads only `features/step-definitions/`, never `.planning/`; it fails when the set of `*World.ts` files on disk and the set of classified Worlds disagree, so a World added without a row here and in the map turns the suite red.

## Vocabulary

- `scaffolded`: the scaffold (`features/step-definitions/shared/EventCapture.ts`, `captureEvents`) removes real repeated tail code from the World (deletion test: the inline subscriber is gone).
- Exempt has two reasons.
  - `hand-wired`: the five Worlds whose header says `Hand-wired on purpose ... (plan 08 exemption)`. The wiring is the thing under test. Source: `.planning/08-test-composition/PLAN.md:803`, as quoted by `.planning/research/FEATURES.md:126` ("Hand-wired exemptions stay hand-wired where the wiring is the thing under test"). Three of the five still call `TestAuth.layer` or `serve` for part of their stacks (Csrf, ContractStratum, Tenancy), so "hand-wired" means the composition under test is not the shared one, not that `TestAuth` is absent.
  - `no-tail`: there is nothing repeated to delete (the deletion test fails).

## The honest record

The shared tail named in the roadmap does not exist as repeated code: `lazyApp` is one call to the shared `TestAuth.lazyApp` primitive per World and `TestClock` is already an option of `TestAuth` (`serve({ testClock })`, `lazyApp(..., { alignStepClock })`), so only the events subscriber repeats, in three Worlds (Admin, Password, Domain). The outcome is a smaller scaffold plus this table (D-05), recorded and not padded: across the three adopters 50 lines were removed and 7 added, and the helper costs 44, a net of +1 line, kept for locality of the reproduced lost-publish race, not for size.

## The table

Composition is how the World reaches `TestAuth` (line numbers measured at this HEAD, comment lines excluded). `lazyApp` is the `TestAuth.lazyApp(...)` call. Clock is how the World sets a clock in its host. Capture is a layer that records events or logs.

| # | File | Class | Composition | lazyApp | Clock | Capture | Reason |
|--:|------|-------|-------------|---------|-------|---------|--------|
| 1 | `AdminWorld.ts` | scaffolded | `TestAuth.layer` :96; `serve` :128 | :138 | none | `captureEvents(events, AuthEvents.is(worldEvents))` :105, as `taps` | The 22-line inline subscriber (`stream`, `Stream.filter`, `startImmediately`) was removed and 3 lines added (ADOPTION-DELTA removed=22 added=3). |
| 2 | `AuthenticationWorld.ts` | hand-wired | none (hand-wired, no `TestAuth` call) | none | none | none | Header :1 `Hand-wired on purpose`: the probe groups re-declare the authentication record; its own composition is under test. |
| 3 | `ClientEffectWorld.ts` | no-tail | none (stub `HttpClient`, no server) | none | none | none | No host at all, so no tail. |
| 4 | `CliWorld.ts` | no-tail | `TestAuth.listen` :265, :283 over `TestAuth.layer` :266, :284 (a socket, not `serve`) | :375 | `alignStepClock` :380 | none (console capture belongs to the CLI) | One `lazyApp` call plus one existing option; `listen` differs from `serve`, nothing repeated. |
| 5 | `ContractStratumWorld.ts` | hand-wired | `authProbeApp` hand-wired; `passwordApp`, `coreOnlyApp` through `TestAuth.serve` :169, :181 and `TestAuth.layer` :170, :181 | none | none | none | Header :3 `Hand-wired on purpose`: `authProbeApp` re-declares the authentication record. Still calls `TestAuth` for the other two apps. |
| 6 | `CsrfWorld.ts` | hand-wired | `TestAuth.layer` :172, :174, :175 under the shipped CSRF middleware | none | none | none | Header :1 `Hand-wired on purpose`: the middleware configuration varied per scenario is the variable under test. Still calls `TestAuth.layer`. |
| 7 | `DeviceAuthorizationWorld.ts` | no-tail | `TestAuth.layer` :85; `serve` :102 | :134 | `alignStepClock` :136 | none | One `lazyApp` call plus one existing option. |
| 8 | `DomainWorld.ts` | scaffolded | `TestAuth.layer` :209; `serve` :281 | none (eager build in `WorldLive`) | none | `captureEvents(probes.events)` :217 | The 14-line inline `eventsLayer` was removed and 2 lines added (ADOPTION-DELTA removed=14 added=2). |
| 9 | `EventsWorld.ts` | no-tail | none directly; `makeHost` :21, :93 from `CrossCuttingApp.ts` | none | none | its own subscriber probes through `subscribe` (:106 to :197), the scenarios under test | The host is `CrossCuttingApp`; the subscribers are the subject of the scenarios, not a repeated tail. |
| 10 | `FoundationsWorld.ts` | no-tail | none | none | none | none | Scratch cell only. |
| 11 | `HooksWorld.ts` | no-tail | `makeHost` :22, :242; `TestAuth.layer` :165 | none | none | none | Host is `CrossCuttingApp`; nothing repeated. |
| 12 | `HttpErrorWorld.ts` | no-tail | `TestAuth.layer` :180, :186, :189, :195, :198, :203, :207; `serve` :154 | none | none | none | No cell, clock or capture to remove. |
| 13 | `JwtWorld.ts` | no-tail | `TestAuth.layer` :33; `serve` :49 | :90 | none | none | One `lazyApp` call. |
| 14 | `MagicLinkWorld.ts` | no-tail | `TestAuth.layer` :114; `serve` :142 | :172 | `alignStepClock` :172 | none | One `lazyApp` call plus one existing option. |
| 15 | `NextSsrWorld.ts` | no-tail | `TestAuth.layer` :79; `serve` :89, :135 | none | none | none | Nothing repeated. |
| 16 | `OAuthWorld.ts` | no-tail | `TestAuth.layer` :116, :138 (no `serve`) | none | ambient `TestClock` | none | Own layering, no tail. |
| 17 | `OrganizationWorld.ts` | no-tail | `TestAuth.layer` :78; `serve` :132 | :185 | none | `Layer.effectDiscard` subscriber :119 to :131 through `authEvents.subscribe` :124 | The subscriber registers through `subscribe` and forks without `startImmediately`. Both subscribe before the first request, so the registration is not the difference; the consumer's first run is, and a `subscribe` helper with a plain fork failed five AdminWorld scenarios (steps that read the Ref without polling). Whether Organization's steps tolerate the helper's timing was not measured, so it stays inline (D-11) as the one remaining candidate for a fourth adopter, not as proof the capture differs. |
| 18 | `PasskeyWorld.ts` | no-tail | `TestAuth.layer` :160; `serve` :206 | :216 | none | none | One `lazyApp` call. |
| 19 | `PasswordWorld.ts` | scaffolded | `TestAuth.layer` :191, :203, :206; `serve` :155, :156 | :239 | none | `captureEvents(events)` :172 | The 14-line inline `eventsLayer` was removed and 2 lines added (ADOPTION-DELTA removed=14 added=2). |
| 20 | `PersistenceStratumWorld.ts` | no-tail | `TestAuth.memoryFoundation` only (`Layer.effectDiscard` :54, :183 are fixtures) | none | none | none | Nothing repeated; reuses `FoundationsWorld`'s cell. |
| 21 | `QadiBridgeWorld.ts` | hand-wired | none (hand-wired, no `TestAuth` call) | none | none | own `Logger.layer` :714 | Header :1 `Hand-wired on purpose`: the fixture is not an `Auth.make` composition (bespoke `HttpApi`, counting `SubjectResolver`). |
| 22 | `RateLimitingWorld.ts` | no-tail | `makeHost` :31, :337; `TestAuth.layer` :94, :160 | none | `TestClock` drives windows in steps | none | Host is `CrossCuttingApp`; nothing repeated. |
| 23 | `ReactWorld.ts` | no-tail | `TestAuth.layer` :44; `serve` :46 | none | none | none | Nothing repeated. |
| 24 | `SamlWorld.ts` | no-tail | `TestAuth.layer` :195; `serve` :234 | :342 | hand-rolled `ClockLive` :189 (`Layer.effectDiscard` + `TestClock.layer`) | own `Logger.layer` `Capture` :181 | The only World with all three pieces, but each is World-specific and alone (1 of 31); extracting them would move lines, not delete repeated ones. |
| 25 | `ScimWorld.ts` | no-tail | `TestAuth.layer` :95; `serve` :142 | :182 | none | none | One `lazyApp` call. |
| 26 | `SessionWorld.ts` | no-tail | `TestAuth.layer` :105; `serve` :189 | :179 | `testClock` :189, :243 (existing option) | none | One `lazyApp` call plus one existing option. |
| 27 | `SmokeWorld.ts` | no-tail | none | none | none | none | Tooling smoke World. |
| 28 | `TenancyWorld.ts` | hand-wired | `TestAuth.layer` :199, :245, :339; every stack through `buildContext` :513, :549 | none | `TestClock` in steps | none | Header :1 `Hand-wired on purpose`: the identity and connection stacks are hand-wired; the organization and OAuth stacks still run on `TestAuth.layer`. |
| 29 | `TestingHarnessWorld.ts` | no-tail | `TestAuth.layer` :51, :84, :138, :152 (and further sites) | none | none | none | The harness's own public surface is the subject. |
| 30 | `TwoFactorWorld.ts` | no-tail | `TestAuth.layer` :115; `buildContext` :258, :518 (no `serve`) | none | `TestClock.adjust` in steps | none | Nothing repeated. |
| 31 | `WebhooksWorld.ts` | no-tail | `TestAuth.layer` :198; `serve` :267 | none | `TestClock.adjust` in steps | none | Nothing repeated. |

`CrossCuttingApp.ts` is an existing features-side host for `HooksWorld`, `EventsWorld` and `RateLimitingWorld`. It calls `TestAuth.layer` but builds with `Layer.buildWithScope`, not `TestAuth.serve`, so `LeakGuard` does not count those Worlds. It is not part of this phase; a second host composer is exactly what D-01 forbids, which is why the scaffold is not one.

## Pinned by

`features/features/_guard/world-table.steps.test.ts` (one test, four assertions):

1. the set of top-level `*World.ts` files in `features/step-definitions/` equals the key set of the inline map (unclassified, or classified but missing);
2. every hand-wired World's first six lines contain `Hand-wired on purpose`;
3. no scaffolded World, line and block comments stripped, subscribes inline (a `.stream`, `.subscribe`, `.on` or `.onBatch` property read), and every scaffolded World calls `captureEvents(`;
4. a World has an import statement from `./shared/EventCapture.ts` if and only if it is classified scaffolded (a path in a comment does not count).
