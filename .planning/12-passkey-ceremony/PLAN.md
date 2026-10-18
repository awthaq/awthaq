# Plan 12: One passkey ceremony module owns the step order

| Property | Value |
|---|---|
| Strength | Strong (architecture review of 2026-10-17). One live spec violation in two endpoints, a second instance of it in all three, and the assertion half written twice |
| Dependency category | in-process (the step order), over a ports-and-adapters seam (`WebAuthn`, mocked in tests) and local-substitutable stores (`ChallengeStore`, `PasskeyCredentials` through `Passkey.Passkey.records.memory`/`.sql`) |
| Wave / order | Independent of plans 11-24. Phase 0 is a hotfix and should ship first, on its own. Phases 1-3 can land before or after plan 22 (which moves `Passkey.ts`'s migrations); the two touch disjoint regions of `Passkey.ts` (§8) |
| Fixes live bugs | **BEH-EA-132**: `register/verify` and `reauthenticate/verify` refuse a bad origin, rpId or embedded ceremony *before* spending the challenge, so the same challenge then verifies. All three ceremonies, sign-in included, also leave the challenge live when `clientDataJSON` cannot be read. Both confirmed by a probe run (§2.3) |
| Execution tickets | `.scratch/passkey-ceremony/issues/NN-*.md`, one per phase (`docs/agents/issue-tracker.md`) |

Every `file:line` below was checked against the tree at `fc990c88` (2026-10-17). Re-check them before editing: plans 11 and 22 also edit `Passkey.ts`.

Vocabulary: **module, interface, implementation, depth, seam, adapter, leverage, locality**. Domain terms come from `spec/glossary.md`. A *ceremony* is one WebAuthn exchange of a challenge for a browser response: registration (modal or conditional), sign-in, or step-up. An endpoint's *posture* is how precisely it reports a refusal (BEH-EA-136): precisely when the caller is authenticated, collapsed into `InvalidCredentials` when it is anonymous. *Admission* is everything an endpoint checks before the attempt starts (a rate-limit budget, session freshness).

---

## 1. Summary, goals, non-goals

### 1.1 Summary

`@awthaq/passkey` exists to be "the glue that decides *which challenge, origin, session and user* a ceremony belongs to" (`packages/passkey/README.md:3`). That glue is written three times, by hand, inside one 696-line `make` (`Passkey.ts:1077-1772`). `registerVerify` (`:1264-1351`), `authenticateCeremony` (`:1457-1565`) and `reauthenticateVerify` (`:1680-1756`) each spell out the same sequence: decode the client data, check the origin, consume the challenge scope, call `WebAuthn.verify*` with the origin, rpId and top-origin expectations, then apply policy. For the two assertion ceremonies that policy is the user-handle check, the UV rule, the counter policy and `recordUsage`, and it is written twice (`:1504-1547` and `:1711-1746`).

Because each endpoint owns its own order, the order drifted:

- `authenticateCeremony` consumes (`:1469`) and then checks the origin (`:1481`), as BEH-EA-132 requires.
- `registerVerify` checks the origin (`:1274`) and **then** consumes (`:1280`).
- `reauthenticateVerify` checks the origin (`:1689`) and **then** consumes (`:1691`).

A registration or step-up attempt refused for its origin, its rpId or an embedded `crossOrigin` therefore leaves its challenge live, and the next attempt with the same challenge succeeds. BEH-EA-132 says a challenge "MUST be deleted from the store on every verification attempt for it, regardless of whether that attempt succeeds" (`spec/behaviors/17-passkey.md:112-115`).

The exploration brief asked whether an undecodable `clientDataJSON` leaves anything to delete. It does. The scope is never read from the client data: it comes from the caller's session (`registrationScope`/`reauthenticateScope`, `:461`, `:465`) or from the payload's `ceremonyId` (`:463`). And `ChallengeStore.consume` pops by scope "whether or not it turns out to match" (`ChallengeStore.ts:149-153`, `:219-227`). All three ceremonies return `PasskeyChallengeInvalid` on unreadable client data *before* consuming (`:1269-1271`, `:1464-1466`, `:1684-1686`), so this is a second instance of the same bug, and the only one in sign-in.

This plan makes the ceremony a **deep module**: `packages/passkey/src/PasskeyCeremony.ts`, internal to the package. Its interface is small:

- `begin(ceremony)` mints the challenge for that ceremony's scope.
- `verifyRegistration({ ceremony, credential, policy })` answers a `VerifiedRegistration` or a `RegistrationRefused { reason }`.
- `verifyAssertion({ ceremony, credential, policy })` answers a `VerifiedAssertion { credential, verified, amr }` or an `AssertionRefused { reason }`.

Behind that interface the module owns:

- the scope strings;
- the one step order (claim the challenge first, always, then origin, then the port, then policy);
- the origin policy;
- the decoy verification for a credential the ceremony may not use (TSS-004);
- the UV rule per kind;
- the attestation policy;
- the user-handle check;
- the counter policy and the usage write.

`Passkey.ts` keeps what genuinely differs per endpoint:

- admission (the per-IP budget, the freshness gate);
- the *posture*: one total `reason → wire error` record per endpoint, checked by the compiler;
- what a registration persists;
- `SignIn.complete` or `Sessions.reauthenticate`.

### 1.2 Corrections to the candidate description (verified)

| Candidate claim | At `fc990c88` |
|---|---|
| config `102-235` | `:102-225` (`AttestationPolicy`, `PasskeyConfigShape`, defaults, `PasskeyConfig`, `config`). `:227-244` is the AAGUID label table |
| WebAuthn helpers `248-420` | `:246-421` (client data, origin policy, response mapping, decoy key, decoy transport sets) |
| HTTP handlers `629-826` | `:629-801`. `:803-826` is the migrations' doc comment |
| migrations `827-973` | `:827-958`. `:960-966` is `passkeyErasure`'s doc comment, misplaced above `passkeyExport`'s (`:967-973`); `passkeyErasure` itself (`:1008`) has none |
| "a ~750-line `make`" | `:1077-1772`, 696 lines |
| `registerVerify` `~1264-1323` | `:1264-1351` (persistence runs to `:1349`) |
| `authenticateCeremony` `~1457-1572` | `:1457-1565`. `authenticateVerify` (the `signInFailed` tap and span) is `:1573-1593` |
| "authenticateCeremony consumes first" | Only after a successful decode. An unreadable `clientDataJSON` returns at `:1464-1466` before the consume at `:1469` (bug B, §2.3) |
| "is the challenge then addressable at all?" | Yes: every scope is known without the client data (§1.1), and `consume` pops by scope, so BEH-EA-132 applies |
| tests "~20 cases (`:38-:523`)" | 25 cases at `:38-:551`, in 9 `describe`s. 18 test ceremony policy; 7 test options, persistence or boot (§5.4) |

Two findings the candidate did not list:

- `Passkey.test.ts:533-563` ("register/verify rejects a response asserting the wrong origin") presents a challenge (`"x"`) that was never issued. It passes today only *because* the origin is checked before the challenge. Phase 0 must fix that test.
- `packages/passkey/README.md:92` ("Limits") is stale. It says a passkey session "does not yet record the client address or user agent, and carries no authentication-method (`amr`) assurance signal". CSD-003 (`Passkey.ts:1559`, test `Passkey.test.ts:227`) and HSK-005 (`:75-81`, tests `:212`, `:219`) shipped both. Phase 3 fixes it.

### 1.3 Goals

1. **BEH-EA-132 holds in every ceremony.** Every verification attempt spends its challenge first, before any other check, including when the client data cannot be read. Phase 0 pins this with tests and hotfixes it; Phase 2 makes it structural.
2. **One implementation of the step order.** The order is written once, in `PasskeyCeremony`. A later step's signature takes a `Claimed` value that only the claim step produces, so the order cannot be re-broken by an edit that checks the origin first.
3. **One origin policy, one UV rule, one counter policy, one decoy rule** in one place, each tested once at the ceremony's interface for every kind.
4. **Posture is data the compiler checks.** Each endpoint maps every refusal reason its ceremony can produce through a `satisfies Posture<…>` record. A new reason fails to compile at every endpoint until that endpoint decides. The three endpoints' wire error unions (`PasskeyShape`, `:499-614`) are unchanged.
5. **Tests move to the deepened interface.** About 47 plugin-level cases that re-test ceremony policy through `registerNewUser`/`buildLayer` are replaced by a ceremony suite with no `Users`, `Sessions` or `TestAuth`, plus three posture tables at the plugin. Nothing is layered.
6. `PasskeyConfig` moves to its own leaf module, so the ceremony can read the config type without a type-level import cycle (`scripts/circular.mjs` counts `import type`).

### 1.4 Non-goals

- **Options generation.** `creationOptions` (`:1175-1200`), `requestOptions` (`:1202-1209`), the TC-001 decoy `allowCredentials` (`:1361-1384`, `:1399-1410`) and `ceremonyKnobsOf` (`:1168-1172`) stay in `Passkey.ts`. Only the challenge issue moves, into `begin` (Q4).
- **Persistence of a registration** (the handle, `credentials.create`, WPS-010, `accounts.link`, `:1321-1349`) and sign-in completion (`signIn.complete`, `:1556-1563`) stay in their endpoints.
- **Migrations and table DDL** (`:803-958`). Plan 22 owns DDL locality and moves each table's DDL to its records module. This plan does not touch them.
- **`PasskeyHandlers`** (`:629-801`) stays in `Passkey.ts`. It reads the `Passkey` service tag, and the class reads `PasskeyHandlers`, so a separate file is a cycle (plan 04 phase 0 hit the same thing and needed a factory). There is no caller for that factory.
- **`currentUserPrincipal`** (`:617-627`) and **`IssuedSession`** (`:494-497`). Plan 11 replaces these copies with shared helpers.
- **The `WebAuthn` port and `ChallengeStore` interfaces** are unchanged. A custom `ChallengeStore` (the spec names Redis) keeps working, because the claim step relies only on the existing contract ("the entry gone either way", `ChallengeStore.ts:82`).
- **New rate limits.** `reauthenticate/verify` and `register/verify` are authenticated and stay unbudgeted, as plan 06 left them.
- **`clientData.type`** (`webauthn.create`/`webauthn.get`) stays the wrapped library's check (`PasskeyVerificationFailed` → refusal `signature`).

---

## 2. Verified current state

### 2.1 `Passkey.ts` map (1,774 lines)

| Lines | What | After this plan |
|---|---|---|
| `:75-81` | `passkeyAmr` (HSK-005) | `PasskeyCeremony` |
| `:84` | `PASSKEY_PROVIDER_ID` | stays |
| `:102-225` | `AttestationPolicy`, `PasskeyConfigShape`, `defaultPasskeyConfig`, `PasskeyConfig`, `config` | `PasskeyConfig.ts` (Phase 1), re-exported |
| `:227-244` | AAGUID labels, `friendlyCredentialName` | stays (registration persistence) |
| `:248-277` | `ClientDataSchema`, `decodeClientData` | `PasskeyCeremony` |
| `:279-330` | `originMatchesRpId`, Android prefix, `checkOrigin`, `acceptedOrigins` | `PasskeyCeremony` (`originRefusal`) |
| `:332-340` | `isHttpsOrigin` (TC-008 boot check) | `PasskeyCeremony`, exported for the boot check |
| `:342-346` | `topOriginExpectation` | `PasskeyCeremony` |
| `:348-392` | `KNOWN_TRANSPORTS`, `toRegistrationResponseJSON`, `toAuthenticationResponseJSON` | `PasskeyCeremony` |
| `:394` | `toBase64Url` | stays (ceremony id, enumeration secret, decoy ids) |
| `:396-409` | `DECOY_COSE_PUBLIC_KEY`, `decoyPublicKey` (TSS-004) | `PasskeyCeremony` |
| `:411-421` | `DECOY_TRANSPORT_SETS` (TC-001, options) | stays |
| `:432-456` | rate-limit `rules` | stays |
| `:459` | `DECOY_USER_ID` (TC-001, options) | stays |
| `:461-465` | four scope functions | `PasskeyCeremony.scopeOf` |
| `:467-614` | `toCredentialDto`, `PasskeySignals`, `IssuedSession`, `PasskeyShape` | stays (plan 11 takes `IssuedSession`) |
| `:617-801` | `currentUserPrincipal`, `PasskeyHandlers` | stays |
| `:803-958` | migrations | stays (plan 22) |
| `:960-1018` | doc comments, `passkeyExport`, `passkeyChallengeRetention`, `passkeyErasure` | stays; Phase 1 moves the misplaced comment `:960-966` onto `passkeyErasure` |
| `:1020-1072` | `class Passkey` | stays |
| `:1077-1772` | `layer`'s `make` | shrinks by roughly 260 lines (§3.7) |

### 2.2 The three verify bodies, step by step

| Step | `registerVerify` `:1264-1351` | `authenticateCeremony` `:1457-1565` | `reauthenticateVerify` `:1680-1756` |
|---|---|---|---|
| config in force (EP-007) | `:1266` | `:1459` | `:1682` |
| admission | freshness `:1267` (BEH-EA-255) | per-IP budget `:1462` (plan 06) | none |
| decode client data | `:1268-1272`, **returns before consume** | `:1463-1467`, **returns before consume** | `:1683-1687`, **returns before consume** |
| origin policy | **`:1274`, before consume** → `PasskeyOriginMismatch`/`PasskeyRpIdMismatch` | `:1481-1483`, after consume → `InvalidCredentials` | **`:1689`, before consume** → precise |
| consume scope | `:1279-1286` (`ceremony` names the scope, WPS-003) | `:1469-1475` | `:1691-1697` |
| credential lookup | n/a | `:1485`; unknown → decoy verify `:1486-1501` → `InvalidCredentials` | `:1699-1709`; unknown **or not the caller's** → `PasskeyCredentialNotFound`, **no decoy verify** |
| port call | `verifyRegistration` `:1288-1303`, `requireUserPresence: !conditional`; fail → `PasskeyVerificationFailed` | `verifyAuthentication` `:1504-1521` with `topOriginExpectation`; fail → `InvalidCredentials` | `verifyAuthentication` `:1711-1728`, same inputs; fail → `PasskeyVerificationFailed` |
| user handle (BPAS-003) | n/a | `:1526-1531` → `InvalidCredentials` | `:1731-1736` → `PasskeyVerificationFailed` |
| UV rule | `required` policy `:1310-1315` | `required` policy **or** flagged credential `:1533-1541` | always `:1738-1740` |
| attestation (HSK-002) | `attestationAcceptable` `:1249-1262`, used `:1317-1319` | n/a | n/a |
| counter policy | n/a | `applyCounterPolicy` `:1544` (defined `:1433-1455`) | `:1743` |
| usage write | n/a | `recordUsage` `:1545-1547` | `:1744-1746` |
| outcome | persist `:1321-1349` | `signIn.complete` `:1556-1563` | `sessions.reauthenticate` `:1750-1754` |

The challenge is minted on the options side at `:1183` (`creationOptions`, scope from `registerOptions` `:1217` and `registerOptionsConditional` `:1238`), `:1394` (`authenticateOptions`) and `:1665` (`reauthenticateOptions`). Each scope string is therefore built in two places per ceremony.

Other copies of ceremony knowledge:

- `acceptedOrigins` is used at `:308`, `:1292`, `:1494`, `:1508` and `:1715`.
- `topOriginExpectation` is used at `:1496`, `:1510` and `:1717`.
- `toAuthenticationResponseJSON` is used at `:1492`, `:1506` and `:1713`.
- `passkeyAmr` is used at `:1558` and `:1751`.
- `decoyCredential` is built in `make` (`:1140`) but used only by sign-in.

Already correct:

- Sign-in's order after decoding.
- REQ-EA-364..366 (`features/features/05-authentication-methods/17-passkey.feature:80-96`). Their failing attempts fail *after* the consume: an unknown credential, and `failVerifyRegistration` (`features/step-definitions/PasskeySteps.ts:597-665`).
- `ChallengeStore`'s own single-use contract (`packages/passkey/test/ChallengeStore.test.ts:223-252`).

### 2.3 Live bugs, with the probe that confirmed them

A throwaway vitest probe (in the session scratchpad, not the repo; it imported `passkeyTestLayers.ts`/`passkeyTestFixtures.ts` by absolute path) ran each row: one refused attempt, then the same challenge from the configured origin.

| Ceremony | First attempt refused for | First answer | Same challenge again | Verdict |
|---|---|---|---|---|
| `registerVerify` | origin `https://evil.example` | `PasskeyOriginMismatch` | **`Success`** | **bug A** |
| `registerVerify` | listed origin `https://other.test` outside `rpId` | `PasskeyRpIdMismatch` | **`Success`** | **bug A** |
| `registerVerify` | `clientDataJSON: "!!!"` | `PasskeyChallengeInvalid` | **`Success`** | **bug B** |
| `reauthenticateVerify` | origin `https://evil.example` | `PasskeyOriginMismatch` | **`Success`** | **bug A** |
| `reauthenticateVerify` | `clientDataJSON: "%%%"` | `PasskeyChallengeInvalid` | **`Success`** | **bug B** |
| `authenticateVerify` | origin `https://evil.example` | `InvalidCredentials` | `Failure` (`PasskeyChallengeInvalid`) | correct |
| `authenticateVerify` | `clientDataJSON: "!!!"` | `PasskeyChallengeInvalid` | **`Success`** | **bug B** |
| `registerVerify` | stale session (6 min) | `PasskeyReauthRequired` | (not retried) | admission, Q1 |

Repro sketch (bug A, registration). This becomes a Phase 0 test:

```ts
const options = yield* passkey.registerOptions(userId, sessionId);
const bad = yield* passkey
  .registerVerify(userId, sessionId, registrationPayload({ options, origin: "https://evil.example" }))
  .pipe(Effect.flip); // PasskeyOriginMismatch
const again = yield* passkey
  .registerVerify(userId, sessionId, registrationPayload({ options })) // same challenge, good origin
  .pipe(Effect.flip); // BEH-EA-132 requires PasskeyChallengeInvalid; today it SUCCEEDS
```

**Impact.** The failing check is exactly the one WebAuthn's origin binding exists for. A phishing relay can obtain a registration or step-up challenge for a victim's session and present it from its own origin. Today the refusal leaves that challenge live for the legitimate origin, so the replay window the single-use design closes is reopened (`spec/behaviors/17-passkey.md:118`: "deleting only on success would let a failed attempt be retried against the same challenge"). The bounding factors are the five-minute TTL, that registration and step-up need the victim's session, and that the authenticator's `rpIdHash` still binds the credential. It is a spec violation, not an account takeover. Bug B adds no attacker capability on its own (garbage client data proves nothing), but it breaks the "every attempt" rule in all three ceremonies.

**Other things checked:**

- *Decoy cost.* On sign-in, an unknown credential costs `findById` (a miss) plus one ES256 verification against the decoy key (`:1490-1499`). A known credential with a bad signature costs `findById` (a hit) plus one verification. The two match up to the store lookup. Step-up pays no verification for an unknown or foreign credential (`:1700-1708`). That is not an enumeration risk (the caller is authenticated, and both answer the same error), but it is a second rule (Q3).
- *Error precedence.* Today a registration or step-up attempt with both a bad origin *and* a dead challenge answers `PasskeyOriginMismatch`; sign-in answers `PasskeyChallengeInvalid`. Spending the challenge first makes all three answer the challenge refusal first (Q2). Only `Passkey.test.ts:533` depends on the old precedence. The BDD helpers issue fresh options per origin check (`PasskeySteps.ts:716-738`), and the `"never-issued"` row (`:1122`) already expects `PasskeyChallengeInvalid`.
- *Annotations.* `applyCounterPolicy` (`:1433-1436`) and `checkOrigin` (`:304-307`) carry explicit Effect return types. Moved code may keep its annotations (no retroactive strip), but the sketches below re-express both, so their new forms carry none.

### 2.4 Tests that exercise ceremony policy today

All of these run through `buildLayer` (`passkeyTestLayers.ts:15-32`, `TestAuth.layer(Auth.make([Passkey]))`), and most of them through `registerNewUser` (`:35-49`): every case builds the whole plugin, a user and a session to test one ceremony rule.

| File | Ceremony-policy cases | Other cases |
|---|---|---|
| `PasskeyCeremony.test.ts` (551) | 18: WPS-003 `:39`, `:64`; CB-002 `:79`, `:102`, `:120`; CB-003 `:142`, `:158`, `:170`, `:187`, `:205`, `:230`; MNA-007 `:248`, `:262`, `:278`; TC-008 `:318`, `:330`, `:355`, `:387` | 7: TC-008 boot `:407`; TC-003 `:422`, `:439`, `:468`; CB-009 `:483`; HSK-003 `:500`; WPS-010 `:524` |
| `Passkey.test.ts` (900) | 10: HSK-005 `:212`, `:219`; replay `:375`; UV `:401`; counter flag `:457` (a duplicate of `PasskeyCounterAnomaly.test.ts:46`); origin `:533`; conditional `:567` (a duplicate of `PasskeyCeremony.test.ts:120`); CB-001 `:627`, `:667`; step-up UV `:835`; step-up foreign credential `:865` | 15 others (registration, sign-in, wiring, `signInFailed`, CSD-003, BEH-EA-136 unknown id `:282`, WPS-001 `:308`, management, freshness, BEH-EA-319) |
| `PasskeyCounterAnomaly.test.ts` (164) | all 8 (`:46`, `:71`, `:84`, `:96`, `:110`, `:124`, `:137`, `:151`) | — |
| `PasskeyEnumeration.test.ts` (221) | TSS-004 `:116`, `:137` | TC-001 ×6, WPS-005 ×4 |
| `PasskeyUserHandle.test.ts` (247) | handle checks `:85`, `:98`, `:111`, `:128` | minting `:31`, `:60`; signals ×2; store suite ×3 |
| `PasskeyAttestation.test.ts` (178) | HSK-002 policy `:36`, `:47`, `:70`, `:90`, `:132` | build-time warning `:153`, `:163` |
| `PasskeyTenantConfig.test.ts` (92) | — | EP-007 ×2 (stay: they prove the config in force reaches the ceremony) |
| `PasskeyRealPort.test.ts` (256) | — | HSK-008 ×6 over the real port (stay) |

`mockWebAuthn` (`passkeyTestFixtures.ts:113-196`) can fail registration only through UP, and authentication never. The "bad signature" case `PasskeyEnumeration.test.ts:137` actually *succeeds* and only counts calls. Phase 2 adds explicit failure knobs.

---

## 3. Target design

### 3.1 Module map (`packages/passkey/src/`)

```
PasskeyConfig.ts     NEW leaf (Phase 1): AttestationPolicy, PasskeyConfigShape, PasskeyConfig, config
PasskeyCeremony.ts   NEW (Phase 2), internal: Ceremony, scopeOf, CeremonyPolicy, refusals, Posture, make
Passkey.ts           endpoints: admission, posture, persistence, options, completion; re-exports config
ChallengeStore.ts    unchanged        PasskeyCredentials.ts  unchanged
PasskeyApi.ts        unchanged        PasskeyUserHandles.ts  unchanged
index.ts             unchanged (PasskeyCeremony and PasskeyConfig are not exported namespaces)
```

Import direction (madge, type-inclusive, stays acyclic): `Passkey.ts → PasskeyCeremony.ts → { PasskeyConfig.ts, PasskeyApi.ts (types), PasskeyCredentials.ts, ChallengeStore.ts }`, and `Passkey.ts → PasskeyConfig.ts`.

### 3.2 `PasskeyConfig.ts` (Phase 1)

A pure move of `Passkey.ts:102-225` with its doc comments, unchanged. The existing annotations on `PasskeyConfig` and `config` move verbatim; they are not new code.

```ts
// @awthaq/passkey — PasskeyConfig
//
// spec/behaviors/17-passkey.md. The plugin's policy knobs (BEH-EA-017's Context.Reference with a
// default). A leaf: `Passkey.ts` (options, boot checks) and `PasskeyCeremony.ts` (verification) both
// read it, and `Passkey.ts` re-exports it, so `Passkey.config(...)` and `Passkey.PasskeyConfig` keep
// their public names.
import type { WebAuthn } from "@awthaq/ports";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Layer from "effect/Layer";
import type * as Redacted from "effect/Redacted";

export interface AttestationPolicy { /* Passkey.ts:102-107, verbatim */ }
export interface PasskeyConfigShape { /* Passkey.ts:109-199, verbatim */ }
const defaultPasskeyConfig: PasskeyConfigShape = { /* :201-216 */ };
export const PasskeyConfig: Context.Reference<PasskeyConfigShape> = Context.Reference(
  "awthaq/passkey/Config",
  { defaultValue: () => defaultPasskeyConfig },
);
export const config = (partial: Partial<PasskeyConfigShape>): Layer.Layer<never> =>
  Layer.succeed(PasskeyConfig, { ...defaultPasskeyConfig, ...partial });
```

In `Passkey.ts`:

```ts
import { PasskeyConfig, type PasskeyConfigShape } from "./PasskeyConfig.ts";
export { PasskeyConfig, config } from "./PasskeyConfig.ts";
export type { AttestationPolicy, PasskeyConfigShape } from "./PasskeyConfig.ts";
```

The reference key `"awthaq/passkey/Config"` is unchanged, so tenant `LayerMap`s (`PasskeyTenantConfig.test.ts:20-30`) and `ConfigDescriptor.make(PasskeyConfig, …)` (`Passkey.ts:1048`) are unaffected.

### 3.3 `PasskeyCeremony.ts`: the interface

```ts
// @awthaq/passkey — PasskeyCeremony (internal: not re-exported from `index.ts`)
//
// spec/behaviors/17-passkey.md, BEH-EA-130..133, 136, 256, 257. The one implementation of what a
// passkey ceremony verifies and in which order. An endpoint names the ceremony (and so its challenge
// scope), hands over the browser's response and the config in force, and gets back a verified
// credential or a refusal *reason*. How loudly to say why is the endpoint's posture (BEH-EA-136),
// never this module's.
//
// One order for every kind; BEH-EA-132 comes first, always:
//   1. claim:  spend the ceremony's challenge, whether or not the client data can be read;
//   2. origin: BEH-EA-133 / MNA-007 / CB-003 / TC-008, one policy;
//   3. port:   `WebAuthn.verify*` (registration: UP per mode; assertion: the stored key, or the
//              decoy key for a credential this ceremony may not use, TSS-004);
//   4. policy: registration: UV, attestation. Assertion: user handle, UV, counter, then the usage write.
import { AuthEvents, type Sessions, type Users } from "@awthaq/core";
import { WebAuthn } from "@awthaq/ports";
import * as Brand from "effect/Brand";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChallengeStore from "./ChallengeStore.ts";
import type * as PasskeyApi from "./PasskeyApi.ts";
import type { PasskeyConfigShape } from "./PasskeyConfig.ts";
import * as PasskeyCredentials from "./PasskeyCredentials.ts";

// ---- what a ceremony is, and its challenge scope ----

export type Ceremony = Data.TaggedEnum<{
  /** BEH-EA-130/256: `mode` is the payload's `ceremony` (absent means modal, WPS-003). */
  Registration: { readonly sessionId: string; readonly mode: "modal" | "conditional" };
  /** BEH-EA-131: anonymous, correlated by the `ceremonyId` its options call minted. */
  SignIn: { readonly ceremonyId: string };
  /** Ticket 15: the caller's own session; only the caller's own credential may answer it. */
  StepUp: { readonly sessionId: string; readonly userId: Users.UserId };
}>;
export const Ceremony = Data.taggedEnum<Ceremony>();
export type Registration = Data.TaggedEnum.Value<Ceremony, "Registration">;
export type Assertion = Data.TaggedEnum.Value<Ceremony, "SignIn" | "StepUp">;

/**
 * BEH-EA-132/256: one challenge scope per ceremony. These strings are stored
 * (`passkey_challenge.scope`) and signed into `layerCookie` values: never change them, or a
 * deploy strands every live challenge.
 */
export const scopeOf = Ceremony.$match({
  Registration: ({ sessionId, mode }) =>
    mode === "conditional"
      ? `passkey.register.conditional:${sessionId}`
      : `passkey.register:${sessionId}`,
  SignIn: ({ ceremonyId }) => `passkey.authenticate:${ceremonyId}`,
  StepUp: ({ sessionId }) => `passkey.reauthenticate:${sessionId}`,
});

// ---- the policy a ceremony reads, and how it refuses ----

/** EP-007: the endpoint reads the config in force per operation and hands this part of it in. */
export type CeremonyPolicy = Pick<
  PasskeyConfigShape,
  | "rpId"
  | "origins"
  | "allowedTopOrigins"
  | "relatedOrigins"
  | "authenticatorSelection"
  | "attestationPolicy"
  | "counterAnomalyPolicy"
>;

export type RegistrationRefusal =
  | "challenge" // unreadable client data, or the scope's challenge is missing, expired or different
  | "origin" // not an accepted origin, or embedded under a top origin nobody allowed
  | "rpId" // an accepted web origin whose host is not `rpId` or under it
  | "signature" // the port refused the response
  | "userVerification" // UV required by the conveyed policy and absent
  | "attestation"; // HSK-002 policy unmet

export type AssertionRefusal =
  | "challenge"
  | "origin"
  | "rpId"
  | "unknownCredential" // no such credential, or (step-up) not the caller's; the decoy was verified
  | "signature"
  | "userHandle" // BPAS-003: the assertion's handle is not the one the credential was registered under
  | "userVerification"
  | "counterAnomaly"; // CB-004 regression under `counterAnomalyPolicy: "reject"`

export class RegistrationRefused extends Data.TaggedError("PasskeyCeremony/RegistrationRefused")<{
  readonly reason: RegistrationRefusal;
}> {}
export class AssertionRefused extends Data.TaggedError("PasskeyCeremony/AssertionRefused")<{
  readonly reason: AssertionRefusal;
}> {}

/**
 * BEH-EA-136: an endpoint's answer to every refusal its ceremony can produce. It is total, so a new
 * reason fails to compile at every endpoint until that endpoint chooses its wire error.
 */
export type Posture<Reason extends string> = { readonly [R in Reason]: () => unknown };

export interface VerifiedAssertion {
  readonly credential: PasskeyCredentials.PasskeyCredentialRecord;
  readonly verified: WebAuthn.VerifiedAuthentication;
  /** HSK-005/THS-003 (BEH-EA-258): `hwk`/`swk`, plus `user` when the authenticator verified the user. */
  readonly amr: ReadonlyArray<Sessions.AuthMethod>;
}

/** TC-008: an exact `https` origin (moved from `Passkey.ts:332-340`; `Passkey.layer`'s boot check uses it). */
export const isHttpsOrigin = (value: string): boolean => {
  /* verbatim */
};

export const make = Effect.gen(function* () {
  /* §3.4 */
  return { begin, verifyRegistration, verifyAssertion };
});
```

Why two refusal classes, not one: with one union of every reason, registration's posture would have to map `counterAnomaly`, `userHandle` and `unknownCredential`, which its ceremony can never produce. That is an unreachable branch with an invented answer. Each verifier names exactly the reasons it can produce, and each posture record is total over exactly those. The tags carry the module prefix, so the internal and wire sets stay disjoint (ESS-008, `pnpm check:error-tags`).

Why `make` and not a `Context.Service`: there is one implementation and no host substitution. Tests substitute what sits *beneath* the module: the stores through `Passkey.Passkey.records.memory`/`.sql`, and the `WebAuthn` port through `Layer.mock`. This follows core's `SignIn.make` precedent (`packages/core/src/SignIn.ts:74`, used at `Passkey.ts:1095`).

### 3.4 `PasskeyCeremony.ts`: the implementation

Module-level, pure helpers are moved from `Passkey.ts` (doc comments kept):

- `ClientDataSchema`/`decodeClientData` (`:248-277`)
- `originMatchesRpId` (`:280-287`)
- the Android prefix (`:290`)
- `acceptedOrigins` (`:327-330`)
- `topOriginExpectation` (`:343-346`)
- `KNOWN_TRANSPORTS` and both response mappers (`:349-392`)
- `DECOY_COSE_PUBLIC_KEY`/`decoyPublicKey` (`:403-409`)
- `passkeyAmr` (`:75-81`)
- `attestationAcceptable` (`:1249-1262`), which becomes module-level because it reads only its arguments

Two helpers are new in form:

```ts
type ClientData = typeof ClientDataSchema.Type;

/**
 * Client data whose challenge this attempt has already spent. Only `claim` makes one, and the origin
 * check and the port call take one, so no step can run before the spend (BEH-EA-132).
 */
type Claimed = Brand.Branded<ClientData, "PasskeyCeremony/Claimed">;
const Claimed = Brand.nominal<Claimed>();

/**
 * What an unreadable client data presents. It can never equal an issued (32 random bytes, base64url)
 * challenge, and `ChallengeStore.consume` deletes the scope's entry "either way" (its contract,
 * `ChallengeStore.ts:82`), so the attempt still spends the challenge.
 */
const NO_CHALLENGE = "";

/** BEH-EA-133, MNA-007, CB-003, TC-008: the one origin policy, as the reason it fails (formerly `checkOrigin`). */
const originRefusal = (claimed: Claimed, policy: CeremonyPolicy): Option.Option<"origin" | "rpId"> => {
  if (!acceptedOrigins(policy).includes(claimed.origin)) return Option.some("origin");
  if (
    claimed.crossOrigin === true &&
    (claimed.topOrigin === undefined || !policy.allowedTopOrigins.includes(claimed.topOrigin))
  ) {
    return Option.some("origin");
  }
  if (claimed.origin.startsWith(ANDROID_APK_KEY_HASH_ORIGIN_PREFIX)) return Option.none();
  if (policy.relatedOrigins.includes(claimed.origin)) return Option.none(); // TC-008
  return originMatchesRpId(claimed.origin, policy.rpId) ? Option.none() : Option.some("rpId");
};
```

`make` holds everything that needs the stores, the port or the event bus:

```ts
export const make = Effect.gen(function* () {
  const challenges = yield* ChallengeStore.ChallengeStore;
  const webAuthn = yield* WebAuthn.WebAuthn;
  const credentials = yield* PasskeyCredentials.PasskeyCredentials;
  const events = yield* AuthEvents.AuthEvents;
  // TSS-004: verified against, never trusted (moved from `Passkey.ts:1140`).
  const decoyCredential = { id: "awthaq-decoy-credential", publicKey: decoyPublicKey() };

  /** The options half: mints the challenge for exactly this ceremony's scope. */
  const begin = (ceremony: Ceremony) => challenges.issue(scopeOf(ceremony));

  /** Step 1 (BEH-EA-132): spends the challenge first, readable client data or not. Only a match yields a `Claimed`. */
  const claim = Effect.fnUntraced(function* (ceremony: Ceremony, clientDataJSON: string) {
    const clientData = decodeClientData(clientDataJSON);
    const spent = yield* challenges.consume(
      scopeOf(ceremony),
      Option.match(clientData, { onNone: () => NO_CHALLENGE, onSome: (data) => data.challenge }),
    );
    return spent ? Option.map(clientData, Claimed) : Option.none();
  });

  const verifyRegistration = Effect.fnUntraced(function* (input: {
    readonly ceremony: Registration;
    readonly credential: PasskeyApi.RegistrationCredentialInput;
    readonly policy: CeremonyPolicy;
  }) {
    const refuse = (reason: RegistrationRefusal) => Effect.fail(new RegistrationRefused({ reason }));
    const claimed = yield* claim(input.ceremony, input.credential.response.clientDataJSON);
    if (Option.isNone(claimed)) return yield* refuse("challenge");
    const origin = originRefusal(claimed.value, input.policy);
    if (Option.isSome(origin)) return yield* refuse(origin.value);
    const verified = yield* webAuthn
      .verifyRegistration({
        response: toRegistrationResponseJSON(input.credential),
        expectedChallenge: claimed.value.challenge,
        expectedOrigin: acceptedOrigins(input.policy),
        expectedRpId: input.policy.rpId,
        // CB-002: only Conditional Create, which Chrome runs without a user gesture, may omit UP.
        requireUserPresence: input.ceremony.mode === "modal",
      })
      .pipe(Effect.catchTag("WebAuthn/VerificationFailed", () => refuse("signature")));
    // CB-001/CB-009: UV follows the conveyed policy, for both modes.
    if (
      input.policy.authenticatorSelection.userVerification === "required" &&
      !verified.userVerified
    ) {
      return yield* refuse("userVerification");
    }
    if (!attestationAcceptable(verified, input.policy)) return yield* refuse("attestation");
    return verified;
  });

  /** WPS-006 and ticket 15: step-up always needs UV; sign-in does when the policy says so or the credential is flagged. */
  const userVerificationRequired = (
    ceremony: Assertion,
    policy: CeremonyPolicy,
    credential: PasskeyCredentials.PasskeyCredentialRecord,
  ) =>
    ceremony._tag === "StepUp" ||
    policy.authenticatorSelection.userVerification === "required" ||
    Option.isSome(credential.counterAnomalyAt);

  /**
   * CB-004/WPS-006 (formerly `applyCounterPolicy`): a regression (`newCounter <= stored`, except the
   * normal `0 === 0`) is published and flagged; whether it also refuses is the policy's call. The
   * stored counter never moves backwards (`PasskeyCredentials.recordUsage`).
   */
  const counterVerdict = Effect.fnUntraced(function* (
    credential: PasskeyCredentials.PasskeyCredentialRecord,
    verified: WebAuthn.VerifiedAuthentication,
    policy: CeremonyPolicy,
  ) {
    const regressed =
      verified.newCounter <= credential.counter &&
      !(verified.newCounter === 0 && credential.counter === 0);
    if (!regressed) return "accepted" as const;
    yield* events.publish({
      _tag: "auth.passkey.counterAnomaly",
      userId: credential.userId,
      credentialId: credential.id,
    });
    // The row was read a moment ago in this ceremony: a vanished row is a bug, not a domain outcome.
    yield* credentials
      .flagCounterAnomaly(credential.id)
      .pipe(Effect.catchTag("PasskeyCredentials/NotFound", Effect.die));
    return policy.counterAnomalyPolicy === "reject" ? ("rejected" as const) : ("accepted" as const);
  });

  /** Sign-in may use any registered credential; step-up only one the caller owns. */
  const usableBy = (ceremony: Assertion, credential: PasskeyCredentials.PasskeyCredentialRecord) =>
    ceremony._tag === "SignIn" || credential.userId === ceremony.userId;

  const verifyAssertion = Effect.fnUntraced(function* (input: {
    readonly ceremony: Assertion;
    readonly credential: PasskeyApi.AuthenticationCredentialInput;
    readonly policy: CeremonyPolicy;
  }) {
    const refuse = (reason: AssertionRefusal) => Effect.fail(new AssertionRefused({ reason }));
    const claimed = yield* claim(input.ceremony, input.credential.response.clientDataJSON);
    if (Option.isNone(claimed)) return yield* refuse("challenge");
    const origin = originRefusal(claimed.value, input.policy);
    if (Option.isSome(origin)) return yield* refuse(origin.value);
    const expected = {
      response: toAuthenticationResponseJSON(input.credential),
      expectedChallenge: claimed.value.challenge,
      expectedOrigin: acceptedOrigins(input.policy),
      expectedRpId: input.policy.rpId,
      ...topOriginExpectation(input.policy),
    };
    const found = Option.filter(yield* credentials.findById(input.credential.id), (row) =>
      usableBy(input.ceremony, row),
    );
    if (Option.isNone(found)) {
      // TSS-004: a credential this ceremony may not use costs the one signature verification a
      // usable credential's bad signature does. The result is discarded.
      yield* webAuthn.verifyAuthentication({ ...expected, credential: decoyCredential }).pipe(Effect.exit);
      return yield* refuse("unknownCredential");
    }
    const credential = found.value;
    const verified = yield* webAuthn
      .verifyAuthentication({
        ...expected,
        credential: {
          id: credential.id,
          publicKey: new Uint8Array(credential.publicKey),
          transports: credential.transports,
        },
      })
      .pipe(Effect.catchTag("WebAuthn/VerificationFailed", () => refuse("signature")));
    // BPAS-003/BEH-EA-257: a discoverable credential returns the handle it was registered under.
    const handle = input.credential.response.userHandle;
    if (handle !== undefined && handle !== credential.webauthnUserId) return yield* refuse("userHandle");
    if (userVerificationRequired(input.ceremony, input.policy, credential) && !verified.userVerified) {
      return yield* refuse("userVerification");
    }
    if ((yield* counterVerdict(credential, verified, input.policy)) === "rejected") {
      return yield* refuse("counterAnomaly");
    }
    yield* credentials
      .recordUsage(credential.id, verified.newCounter, verified.credentialBackedUp)
      .pipe(Effect.catchTag("PasskeyCredentials/NotFound", Effect.die));
    return { credential, verified, amr: passkeyAmr(verified) };
  });

  return { begin, verifyRegistration, verifyAssertion };
});
```

Notes for the executor:

- **No `as` other than `as const`** (allowed by the `.oxlintrc.json` override, as plan 07 records), and **no return-type annotations** on `make`, `begin`, `claim`, `verifyRegistration`, `verifyAssertion` or `counterVerdict`. `originRefusal` and `isHttpsOrigin` are plain functions; their annotations are not Effect types.
- The inferred error type of `verifyRegistration` is `RegistrationRefused | StoreFailure.StoreUnavailable`. For `verifyAssertion` it is `AssertionRefused | StoreUnavailable`. `StoreUnavailable` comes from `consume`, `findById`, `flagCounterAnomaly` and `recordUsage`, and propagates untouched (ADR-EA-028).
- `Brand.nominal<Claimed>()` constructs the brand without an assertion (core's `Users.UserId` precedent, `packages/core/src/Users.ts:30`). If TS cannot apply `Brand.Branded` to the object `ClientData`, use `interface Claimed extends ClientData, Brand.Brand<"PasskeyCeremony/Claimed"> {}`.
- `counterVerdict` keeps today's order: the event, then the flag, then the verdict. Under `"reject"` the usage write is skipped, as it is today: `applyCounterPolicy` fails before `recordUsage` at `:1545`.
- Under `"flag"`, the flagged-credential UV rule reads `counterAnomalyAt` *as stored before this assertion*. This assertion's own regression flags the credential for the next use, not for this one, exactly as `:1537` does today (`PasskeyCounterAnomaly.test.ts:71` pins this).
- `make`'s requirements are `ChallengeStore | WebAuthn | PasskeyCredentials | AuthEvents`. `Passkey.layer`'s `make` already yields all four (`:1081-1084`), so the plugin's `R` does not change.

### 3.5 What `Passkey.ts` keeps: admission, posture, outcome

The postures are module-level (pure), next to `PasskeyHandlers`:

```ts
const invalidCredentials = () => new Api.InvalidCredentials();

/** BEH-EA-136: `register/verify` is authenticated and names no one else's identifier, so it reports every refusal precisely. */
const registrationPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: () => new PasskeyApi.PasskeyOriginMismatch(),
  rpId: () => new PasskeyApi.PasskeyRpIdMismatch(),
  signature: () => new PasskeyApi.PasskeyVerificationFailed(),
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  attestation: () => new PasskeyApi.PasskeyAttestationRejected(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.RegistrationRefusal>;

/**
 * BEH-EA-136: the anonymous sign-in collapses every refusal past the challenge into the same
 * `InvalidCredentials` an unknown password-sign-in email answers. The two exceptions are refusals a
 * client must act on (verify the user; a counter anomaly), and both are reachable only after a valid
 * signature from a registered credential.
 */
const signInPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: invalidCredentials,
  rpId: invalidCredentials,
  unknownCredential: invalidCredentials,
  signature: invalidCredentials,
  userHandle: invalidCredentials,
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  counterAnomaly: () => new PasskeyApi.PasskeyCounterAnomaly(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.AssertionRefusal>;

/** Ticket 15: step-up is authenticated as the credential's would-be owner, so it reports precisely, like registration. */
const stepUpPosture = {
  challenge: () => new PasskeyApi.PasskeyChallengeInvalid(),
  origin: () => new PasskeyApi.PasskeyOriginMismatch(),
  rpId: () => new PasskeyApi.PasskeyRpIdMismatch(),
  unknownCredential: () => new PasskeyApi.PasskeyCredentialNotFound(),
  signature: () => new PasskeyApi.PasskeyVerificationFailed(),
  userHandle: () => new PasskeyApi.PasskeyVerificationFailed(),
  userVerification: () => new PasskeyApi.PasskeyUserVerificationRequired(),
  counterAnomaly: () => new PasskeyApi.PasskeyCounterAnomaly(),
} satisfies PasskeyCeremony.Posture<PasskeyCeremony.AssertionRefusal>;
```

`satisfies` checks totality (a missing key fails) and exactness (an excess key in the literal fails). The literal keeps its own inferred type, so `registrationPosture[refused.reason]()` has the union of the six concrete returns, and no assertion is needed. The endpoint consts keep their existing `PasskeyShape[...]` annotations (`:1264`, `:1457`, `:1680`). If a posture ever produced a wire error outside an endpoint's declared union, the annotation would fail to compile. That is the guard that the three wire unions stay as they are.

In `make` (after `const signIn = yield* SignIn.make`, `:1095`):

```ts
const ceremonies = yield* PasskeyCeremony.make;
```

The endpoints:

```ts
const registerVerify: PasskeyShape["registerVerify"] = Effect.fnUntraced(
  function* (userId, sessionId, input) {
    const config = yield* configNow;
    // Admission (BEH-EA-255): a stale session is refused before the attempt starts, so its challenge
    // survives the step-up that discharges the gate (BEH-EA-132 "As shipped"; Q1).
    yield* requireFreshSession(userId, sessionId);
    const verified = yield* ceremonies
      .verifyRegistration({
        ceremony: PasskeyCeremony.Ceremony.Registration({ sessionId, mode: input.ceremony ?? "modal" }),
        credential: input.credential,
        policy: config,
      })
      .pipe(
        Effect.catchTag("PasskeyCeremony/RegistrationRefused", (refused) =>
          Effect.fail(registrationPosture[refused.reason]()),
        ),
      );
    // BPAS-003, WPS-010, BEH-EA-134: what a registration persists. Unchanged from :1321-1349.
    const webauthnUserId = yield* handles.getOrCreate(userId);
    /* credentials.create(...), PasskeyAlreadyRegistered mapping, accounts.link(...) */
  },
);

const authenticateCeremony: PasskeyShape["authenticateVerify"] = Effect.fnUntraced(
  function* (input, context) {
    const config = yield* configNow;
    // Admission (plan 06): the per-source budget is spent before the attempt starts.
    yield* limits.spend("authenticateVerifyByIp", { ip: input.ip });
    const { credential, amr } = yield* ceremonies
      .verifyAssertion({
        ceremony: PasskeyCeremony.Ceremony.SignIn({ ceremonyId: input.ceremonyId }),
        credential: input.credential,
        policy: config,
      })
      .pipe(
        Effect.catchTag("PasskeyCeremony/AssertionRefused", (refused) =>
          Effect.fail(signInPosture[refused.reason]()),
        ),
      );
    // ADR-EA-038 + WPS-001: core's sign-in completes it; a vanished user is the same uniform refusal.
    return yield* signIn
      .complete({ userId: credential.userId, strategy: "passkey", amr }, { ip: input.ip, userAgent: context?.userAgent })
      .pipe(Effect.catchTag("SignIn/UserGone", () => Effect.fail(new Api.InvalidCredentials())));
  },
);

const reauthenticateVerify: PasskeyShape["reauthenticateVerify"] = Effect.fnUntraced(
  function* (userId, sessionId, input) {
    const config = yield* configNow;
    const { amr } = yield* ceremonies
      .verifyAssertion({
        ceremony: PasskeyCeremony.Ceremony.StepUp({ sessionId, userId }),
        credential: input.credential,
        policy: config,
      })
      .pipe(
        Effect.catchTag("PasskeyCeremony/AssertionRefused", (refused) =>
          Effect.fail(stepUpPosture[refused.reason]()),
        ),
      );
    // BEH-EA-319: unchanged (:1748-1754).
    yield* sessions
      .reauthenticate(userId, Sessions.SessionId(sessionId), amr)
      .pipe(Effect.catchTag("Sessions/NotFound", () => Effect.fail(new Api.Unauthenticated())));
  },
);
```

The options side uses `begin`:

- `creationOptions` (`:1175-1200`) takes `ceremony: PasskeyCeremony.Registration` instead of `scope: string`, and calls `ceremonies.begin(ceremony)` where it called `challengeStore.issue(scope)` (`:1183`).
- `registerOptions` (`:1217`) passes `Ceremony.Registration({ sessionId, mode: "modal" })`.
- `registerOptionsConditional` (`:1238`) passes `{ sessionId, mode: "conditional" }`.
- `authenticateOptions` (`:1394`) calls `ceremonies.begin(Ceremony.SignIn({ ceremonyId }))`.
- `reauthenticateOptions` (`:1665`) calls `ceremonies.begin(Ceremony.StepUp({ sessionId, userId }))`.

Unchanged in `Passkey.ts`: `authenticateVerify`'s `signInFailed` tap and span (`:1573-1593`; the tags it lists are exactly the sign-in posture's outputs), the boot checks (`:1099-1129`, the TC-008 check now calling `PasskeyCeremony.isHttpsOrigin`), and `challengeStore.guarantees` (`:1125`). After this plan, the only `ChallengeStore` use left in `Passkey.ts` is that boot warning and the retention contribution (`:1000-1006`).

### 3.6 What changes in behaviour

| Change | Where | Visible as |
|---|---|---|
| Registration and step-up spend the challenge before the origin check | Phase 0 (hotfix), then structural in Phase 2 | A retried same-challenge `register/verify`/`reauthenticate/verify` after an origin/rpId refusal answers `PasskeyChallengeInvalid` |
| All three spend the challenge on unreadable client data | Phase 0, then Phase 2 | Same, after a `PasskeyChallengeInvalid` |
| A dead challenge outranks an origin refusal at registration and step-up | Phase 0 (follows from the above) | `PasskeyChallengeInvalid` instead of `PasskeyOriginMismatch` when both are wrong (Q2) |
| Step-up pays the decoy verification for an unknown or foreign credential | Phase 2 | Timing only; still `PasskeyCredentialNotFound` (Q3) |

Admission refusals do not touch the challenge. The ones that exist are the per-IP budget, the freshness gate, and the `SessionDelivery.respond` token-delivery mode check that runs before the mint (`Passkey.ts:698`, README `:78`). That is today's behaviour, now stated in BEH-EA-132 (Q1).

### 3.7 Size after the plan

Estimates for the executor, not targets. `Passkey.ts` goes from about 1,774 to about 1,390 lines: about 125 lines of config leave, about 175 lines of helpers, and about 85 lines net from the three verify bodies and the counter/attestation helpers. `PasskeyConfig.ts` is about 140 lines, and `PasskeyCeremony.ts` about 400.

### 3.8 Alternatives considered

- **(a) Reorder the three bodies in place (Phase 0 alone).** Rejected as the end state. The bug exists *because* the order is spelled out three times, and the next edit to one body can drift it again. Phase 0 is that reorder, kept as a hotfix.
- **(b) A step-ordered `claim` primitive in `ChallengeStore`.** Rejected: the order spans the store, the origin policy and the port, and the store cannot know the origin. It would also widen a host-implementable interface for one caller.
- **(c) `ChallengeStore.consume(scope, Option<string>)`, or a new `discard(scope)`.** Rejected: the existing contract already deletes by scope whatever value is presented, so `NO_CHALLENGE` needs nothing new from custom stores.
- **(d) One `Refused` class over every reason.** Rejected (§3.3).
- **(e) `PasskeyCeremony` as a `Context.Service` with a layer.** Rejected (§3.3).
- **(f) Move options generation in as well.** Deferred (Q4).

---

## 4. Phased migration

Every phase gate is `pnpm typecheck && pnpm test && pnpm lint && pnpm knip && pnpm circular`. Only `.reports/` files may be reported unused by knip (`.planning/IMPLEMENTING.md`). Phases 0 and 2 also run `pnpm test:bdd`. The plan gate is `pnpm check && pnpm test:pg`; `test:pg` matters because Phase 2 runs the BEH-EA-132 table over the SQL bundle and adds the suite to `scripts/test-pg.sh`. One ticket per phase goes under `.scratch/passkey-ceremony/issues/` when work starts.

**Preconditions:** re-run `grep -n "challengeStore\.\(consume\|issue\)\|checkOrigin\|decodeClientData" packages/passkey/src/Passkey.ts`. If plan 11 or 22 has landed, re-anchor the line numbers in §2.

### Phase 0: pin BEH-EA-132 and hotfix it in place (ship first, alone)

Tests first. Each row fails today exactly as §2.3 says.

1. `packages/passkey/test/passkeyTestFixtures.ts`: `registrationPayload` (`:53-82`) and `assertionCredential` (`:85-111`) gain `clientDataJSON?: string`, which, when given, replaces the built one (for the unreadable rows).
2. `packages/passkey/test/PasskeyCeremony.test.ts`: a new `describe("BEH-EA-132: every verification attempt spends its challenge, whatever else is wrong with it")`, table-driven:

   ```ts
   const spoilers = {
     "unreadable client data": { clientDataJSON: "not base64url!" },
     "an origin outside origins": { origin: "https://evil.example" },
     "a listed origin outside rpId": { origin: "https://other.test" },
     "an embedded ceremony nobody allowed": { crossOrigin: true, topOrigin: "https://evil.example" },
   } as const;
   const config = { origins: [ORIGIN, "https://other.test"] }; // so the rpId row reaches the rpId check

   for (const [name, spoil] of Object.entries(spoilers)) {
     it.effect(`register/verify refused for ${name} spends the challenge`, () =>
       Effect.gen(function* () {
         const passkey = yield* Passkey.Passkey;
         const { userId, sessionId } = yield* newUserSession(`r-${name}@example.com`);
         const options = yield* passkey.registerOptions(userId, sessionId);
         yield* passkey
           .registerVerify(userId, sessionId, registrationPayload({ options, ...spoil }))
           .pipe(Effect.flip);
         const again = yield* passkey
           .registerVerify(userId, sessionId, registrationPayload({ options }))
           .pipe(Effect.flip);
         assert.strictEqual(again._tag, "PasskeyChallengeInvalid");
       }).pipe(Effect.provide(buildLayer(mockWebAuthn(), config))),
     );
     // the same row for reauthenticate/verify, through registerNewUser + reauthenticateOptions
   }
   // sign-in: "unreadable client data" (red today) and "an origin outside origins" (green today,
   // kept as the regression guard for the order sign-in already has)
   ```

   That is 10 cases: 4 registration, 4 step-up, 2 sign-in. 9 are red today.
3. `packages/passkey/test/Passkey.test.ts:533-563`: issue `registerOptions` first and present its challenge from `https://evil.example`. Otherwise the fixed order answers `PasskeyChallengeInvalid` for the never-issued `"x"`. The test moves to the ceremony suite in Phase 2 anyway.
4. BDD, `features/features/05-authentication-methods/17-passkey.feature`, under `Rule: Challenges are single-use and short-lived` (after `:96`):

   ```gherkin
       Scenario: A challenge presented from an origin the relying party does not accept is spent all the same
         Given a challenge issued for a ceremony
         When a verification attempt presents that challenge from origin "https://evil.example"
         Then that attempt is refused as "PasskeyOriginMismatch"
         And presenting the same challenge from the configured origin is refused as "PasskeyChallengeInvalid"
   ```

   - Run `python3 features/scripts/allocate-req-ea.py` to tag it (the next free id; 1306 is the highest at `fc990c88`, and sibling plans allocate too) and regenerate `features/traceability.md`.
   - Steps in `features/step-definitions/PasskeySteps.ts`: `verifyChallenge` (`:71-94`) gains `origin = ORIGIN`. The new When/Then pair reuses the existing Given (`:496-504`) and `assertRejectedWith` (`:102-108`).

Then the hotfix, the smallest change that turns the rows green:

5. `packages/passkey/src/Passkey.ts`, in all three verify bodies: decode, then consume the scope with `Option.match(clientDataOpt, { onNone: () => "", onSome: (data) => data.challenge })`, then refuse `PasskeyChallengeInvalid` when `!consumed || Option.isNone(clientDataOpt)`, then check the origin.
   - `registerVerify`: move `:1274` below the consume. The consume block (`:1276-1286`) moves up to sit right after the decode.
   - `reauthenticateVerify`: move `:1689` below `:1691-1697`.
   - `authenticateCeremony`: only the decode early return (`:1464-1466`) changes; the origin check already follows the consume.
   - Add a one-line comment at each: `BEH-EA-132: spend first, even when the client data is unreadable (the scope never comes from it)`.
6. Spec: the BEH-EA-132 text from §6.1 (step order, admission and precedence paragraphs). The `PasskeyCeremony` sentence waits for Phase 3.
7. `.changeset/passkey-challenge-spent-every-attempt.md` (§6.4).

Gate: phase gate plus `pnpm test:bdd`.

### Phase 1: `PasskeyConfig.ts` leaf (no behaviour change)

1. New `packages/passkey/src/PasskeyConfig.ts` (§3.2), moving `Passkey.ts:102-225`. The imports it needs (`Context`, `Duration`, `Layer`, `Redacted`, `WebAuthn` types) leave `Passkey.ts` only if nothing else there uses them. `Duration` and `Redacted` stay.
2. `Passkey.ts`: the import and re-exports from §3.2.
3. Housekeeping in the same region: move the `passkeyErasure` doc comment (`:960-966`) down onto `passkeyErasure` (`:1008`). Skip this step if plan 22 already did.
4. No test changes. `Passkey.config`, `Passkey.PasskeyConfig` and `Passkey.PasskeyConfigShape` resolve through the re-exports. Their users are `passkeyTestLayers.ts:28`, `PasskeyTenantConfig.test.ts:23`, `Passkey.test.ts:605`, `AuthHttp.test.ts` and `features/step-definitions/PasskeyWorld.ts`.

Gate: the phase gate. If `pnpm package:smoke` exists for this package's exports, run it too (the `Passkey` namespace must still expose `config`).

### Phase 2: `PasskeyCeremony` owns the step order

Tests first: write the ceremony suite (§5.1) against the not-yet-existing module; it fails to compile. Then:

1. New `packages/passkey/src/PasskeyCeremony.ts` (§3.3, §3.4).
2. `packages/passkey/src/Passkey.ts`
   - Delete what moved: `:75-81`, `:248-392` except `toBase64Url` (`:394`), `:396-409`, `:461-465`, `:1140`, `:1245-1262` and `:1424-1455`. Keep `DECOY_TRANSPORT_SETS` (`:411-421`), `DECOY_USER_ID` (`:459`) and `friendlyCredentialName`.
   - Add the three postures (§3.5) and `const ceremonies = yield* PasskeyCeremony.make` in `make`.
   - Rewrite `registerVerify`, `authenticateCeremony` and `reauthenticateVerify` (§3.5). Phase 0's hotfix lines disappear with them.
   - Switch the four options generators to `ceremonies.begin` (§3.5).
   - The TC-008 boot check (`:1111`) calls `PasskeyCeremony.isHttpsOrigin`.
   - Prune unused imports (`Result` most likely). Let `pnpm lint` and `pnpm knip` say which.
   - Rewrite the header comment's last paragraph (`:17-23`): the scopes and the step order live in `PasskeyCeremony.ts`.
3. `packages/passkey/test/passkeyTestFixtures.ts`: `mockWebAuthn` gains `fail?: { readonly registration?: boolean; readonly authentication?: boolean }`. When set, the matching `verify*` fails `WebAuthn.PasskeyVerificationFailed`, which drives the `signature` rows. Keep the UP behaviour at `:166-168`.
4. Tests, all in this phase (replace, don't layer; §5):
   - Rewrite `packages/passkey/test/PasskeyCeremony.test.ts` to the ceremony interface (§5.1). This replaces its 18 ceremony cases and the 10 Phase 0 rows.
   - Move its 7 non-ceremony cases into `Passkey.test.ts` (§5.2).
   - Delete `packages/passkey/test/PasskeyCounterAnomaly.test.ts`.
   - Delete the moved cases from `Passkey.test.ts`, `PasskeyEnumeration.test.ts`, `PasskeyUserHandle.test.ts` and `PasskeyAttestation.test.ts` (§5.4).
   - Add the three posture tables and the two admission cases (§5.2).
5. `scripts/test-pg.sh`: add `packages/passkey/test/PasskeyCeremony.test.ts` to `suites` (next to `:55-57`).
6. No changeset: no package-visible change beyond Phase 0. The `Passkey` namespace keeps every export, and the step-up decoy changes timing only. If Q3 is answered "no decoy at step-up", drop that `usableBy` branch's decoy for `StepUp` and its test.

Gate: the phase gate, `pnpm test:bdd` (REQ-EA-355..381, 696, 1007..1024 and Phase 0's id unchanged in meaning) and `pnpm test:pg`.

### Phase 3: spec, docs, sweep

1. Spec, glossary and traceability edits (§6.1 to §6.3).
2. `packages/passkey/README.md`:
   - In "Notable behavior" (`:69-74`), add: "**Every verification attempt spends its challenge first**, before the origin is even checked, so no refused attempt can be retried with the same challenge (BEH-EA-132)."
   - In "Limits" (`:92`), delete the stale bullet about the client address, user agent and `amr` (§1.2).
3. Sweep greps (each must return nothing):
   - `grep -n "challengeStore\.consume\|challengeStore\.issue\|decodeClientData\|checkOrigin\|applyCounterPolicy\|verifyAuthentication\|verifyRegistration\|passkey\.register:\|passkey\.authenticate:\|passkey\.reauthenticate:" packages/passkey/src/Passkey.ts`
   - `grep -rn " as [A-Z]\| as unknown\| as any" packages/passkey/src/PasskeyCeremony.ts packages/passkey/src/PasskeyConfig.ts`
4. `pnpm check && pnpm test:pg`, plus `pnpm spec:verify:strict`, `pnpm check:error-tags` and `pnpm check:readmes`.

---

## 5. Test plan

Replace, don't layer: each ceremony rule is tested once, at `PasskeyCeremony`'s interface, for every kind it applies to. The plugin keeps admission, posture, options, persistence and completion. BDD keeps the wire-level guard.

### 5.1 `packages/passkey/test/PasskeyCeremony.test.ts` (rewritten)

Composition: no `Users`, no `Sessions`, no `TestAuth`. Credentials are seeded directly.

```ts
/** `records` is `Passkey.Passkey.records.memory`, or `.sql` with its `SqlClient` and migrations already provided. */
const ceremonyLayer = (
  webAuthn: Layer.Layer<WebAuthn.WebAuthn>,
  records: Layer.Layer<
    ChallengeStore.ChallengeStore | PasskeyCredentials.PasskeyCredentials | PasskeyUserHandles.PasskeyUserHandles,
    unknown,
    Crypto.Crypto
  > = Passkey.Passkey.records.memory,
) =>
  Layer.mergeAll(records, webAuthn).pipe(
    Layer.provideMerge(AuthEvents.layer),
    Layer.provideMerge(AuditLog.layer.pipe(Layer.provide(Persistence.memory))),
    Layer.provideMerge(NodeCrypto.layer),
  );
// SQL leg: Passkey.Passkey.records.sql over TestSql.layer("passkey_PasskeyCeremony") +
// Migrations.run(Passkey.Passkey.migrations) (pattern: PasskeyCredentials.test.ts:19-28).

const policy: PasskeyCeremony.CeremonyPolicy = {
  rpId: RP_ID,
  origins: [ORIGIN],
  allowedTopOrigins: [],
  relatedOrigins: [],
  authenticatorSelection: { userVerification: "preferred" },
  counterAnomalyPolicy: "flag",
};
const seed = (overrides?: Partial<{ id: string; userId: Users.UserId; counter: number }>) =>
  PasskeyCredentials.PasskeyCredentials.use((store) =>
    store.create({ id: "cred-1", userId: Users.UserId("u-1"), webauthnUserId: "h-1", /* … */ ...overrides }),
  );
const kinds = {
  modal: Ceremony.Registration({ sessionId: "s-1", mode: "modal" }),
  conditional: Ceremony.Registration({ sessionId: "s-1", mode: "conditional" }),
  signIn: Ceremony.SignIn({ ceremonyId: "c-1" }),
  stepUp: Ceremony.StepUp({ sessionId: "s-1", userId: Users.UserId("u-1") }),
};
```

`TestAuth.layer` and `registerNewUser` are not used. If `AuthEvents.layer` needs more than `AuditLog` (it reads `AuditWritePolicy`, `AuthRequestContext` and `TenantContext`, all of which have reference defaults), follow `packages/core/test/SignIn.test.ts:91-96`.

**A. BEH-EA-132: step order** (runs over `records.memory` and `records.sql`; SQLite locally, Postgres under `test:pg`)

1. `BEH-EA-132: <kind> refused for <spoiler> spends the challenge; the same challenge then refuses "challenge"`. Kinds are modal, conditional, signIn and stepUp. Spoilers are unreadable client data, an origin outside `origins`, a listed origin outside `rpId`, an embedded ceremony with no allowed top origin, and a refused signature (`fail`). For signIn and stepUp there is also an unknown credential. That makes 22 rows per bundle.
2. `BEH-EA-132: an unreadable client data names no challenge yet still spends the scope` (asserts through a fresh `consume` of the live value that it is gone).
3. `WPS-003: a conditional challenge presented as modal refuses "challenge"; completing the conditional ceremony leaves a concurrently issued modal challenge usable` (replaces `:39`, `:64`).
4. `BEH-EA-132: a sign-in challenge never satisfies a step-up, and vice versa` (scopes are disjoint by kind).
5. `BEH-EA-132/256: scopeOf answers the four persisted scope strings exactly` (pins `passkey.register:`, `passkey.register.conditional:`, `passkey.authenticate:`, `passkey.reauthenticate:`).
6. `BEH-EA-132: the port is never called for a refused challenge or origin` (spy is empty).

**B. BEH-EA-133: one origin policy** (each case runs for all four kinds)

7. `an exact configured origin is accepted; a scheme or port variant refuses "origin"` (REQ-EA-369's unit twin).
8. `a listed origin whose host is not rpId or under it refuses "rpId"; a subdomain is accepted` (REQ-EA-696's unit twin).
9. `CB-003: crossOrigin with no topOrigin, or an unlisted one, refuses "origin"` (replaces `:142`, `:158`, `:170`, `:187`).
10. `CB-003: an allowed top origin is accepted, and an assertion forwards it as expectedTopOrigin; a non-embedded ceremony forwards none` (replaces `:205`, `:230`).
11. `MNA-007: a listed android:apk-key-hash origin is accepted (exempt from the rpId check); an unlisted one refuses "origin"` (replaces `:248`, `:262`, `:278`).
12. `TC-008: by default an origin outside origins refuses "origin"; a configured related origin is accepted, exempt from rpId, and the port is told to expect both lists` (replaces `:318`, `:330`, `:355`).
13. `TC-008: a related origin is not an allowed top origin` (replaces `:387`).

**C. Registration** (BEH-EA-130/135/256)

14. `CB-002: modal asks the port for user presence, conditional does not` (spy; replaces `:79`).
15. `CB-002: a modal response without UP refuses "signature"; a conditional one with UP=0/UV=0 is verified` (replaces `:102`, `:120`, `Passkey.test.ts:567`).
16. `CB-001: UV=0 is verified under "preferred" and refuses "userVerification" under "required", in both modes` (replaces `Passkey.test.ts:627`, `:667`).
17. `HSK-002: with a policy, a none attestation refuses "attestation"` (replaces `PasskeyAttestation.test.ts:36`).
18. `HSK-002: a certificate attestation from a listed AAGUID is verified, case-insensitively; an unlisted one refuses "attestation"` (`:47`, `:70`).
19. `HSK-002: a self-attestation refuses by default and is verified with rejectSelfAttestation: false` (`:90`).
20. `BEH-EA-135: with no policy nothing about the attestation is enforced` (`:132`).
21. `HSK-003: transports the plugin does not recognise never reach the port` (new).

**D. Assertions** (BEH-EA-131/136/257/258)

22. `TSS-004: an unknown credential costs exactly one verification, against the decoy key (a non-empty key, never the presented id), then refuses "unknownCredential"`, for signIn and stepUp (replaces `PasskeyEnumeration.test.ts:116`).
23. `ticket 15: at step-up, a credential owned by another user is "unknownCredential", after the same decoy verification` (replaces `Passkey.test.ts:865`'s policy half).
24. `TSS-004: a usable credential's bad signature costs one verification and refuses "signature"` (replaces `PasskeyEnumeration.test.ts:137`, which never failed).
25. `BPAS-003: a matching userHandle, and an absent one, are verified; a different one refuses "userHandle"`, both kinds (replaces `PasskeyUserHandle.test.ts:85`, `:98`, `:111`, `:128`).
26. `BEH-EA-131: sign-in refuses "userVerification" with UV=0 under "required" and verifies it under "preferred"; step-up refuses UV=0 always` (replaces `Passkey.test.ts:401`, `:835`).
27. `CB-004 flag: a regression is verified, publishes auth.passkey.counterAnomaly once, flags the credential and keeps the stored counter` (replaces `PasskeyCounterAnomaly.test.ts:46`, `Passkey.test.ts:457`).
28. `WPS-006: a flagged credential's next sign-in needs UV; with UV it is verified` (`:71`, `:84`).
29. `CB-004: an advancing counter moves the stored counter forward and flags nothing; 0 === 0 is not an anomaly` (`:96`, `:110`).
30. `CB-004 reject: a regression refuses "counterAnomaly", flags the credential, keeps the counter and records no usage (lastUsedAt unchanged)`, for both kinds (`:124`, `:137`).
31. `CB-004 reject: a non-regressing assertion is verified` (`:151`).
32. `HSK-005: amr is [hwk, user] for a device-bound key with UV, [swk] for a synced key without` (replaces `Passkey.test.ts:212`, `:219`).
33. `ADR-EA-028: a store outage during the claim or the lookup is StoreUnavailable, never a refusal` (a failing `ChallengeStore`/`PasskeyCredentials` decorator; new).

### 5.2 Plugin-level tests that stay or are added

**`packages/passkey/test/Passkey.test.ts`**, added:

- `BEH-EA-136 posture: register/verify answers each ceremony refusal precisely`. Table rows: challenge → `PasskeyChallengeInvalid`, origin → `PasskeyOriginMismatch`, rpId → `PasskeyRpIdMismatch`, signature → `PasskeyVerificationFailed`, userVerification → `PasskeyUserVerificationRequired`, attestation → `PasskeyAttestationRejected`. Each row provokes its reason through the endpoint with the fixtures and its own `buildLayer` config.
- `BEH-EA-136 posture: authenticate/verify answers InvalidCredentials for every refusal past the challenge except userVerification and counterAnomaly`. Eight rows; it absorbs `:282`, the `InvalidCredentials` halves of `:170` and `:278`, and `PasskeyUserHandle.test.ts:111`'s wire answer.
- `posture: reauthenticate/verify answers precisely`. Eight rows; it absorbs `:865` (→ `PasskeyCredentialNotFound`), the `PasskeyVerificationFailed` of `PasskeyUserHandle.test.ts:128`, and `PasskeyCeremony.test.ts:187`.
- `BEH-EA-132/255 admission: a register/verify refused for a stale session leaves the challenge usable once a step-up discharges the gate`. This pins Q1; flip it if Q1 is answered the other way.

Moved in from the old `PasskeyCeremony.test.ts`:

- TC-008 boot refusal (`:407`)
- TC-003 timeouts, hints and the TTL bound (`:422`, `:439`, `:468`)
- CB-009 (`:483`)
- HSK-003 persisted transports echoed into `excludeCredentials` (`:500`)
- WPS-010 duplicate id (`:524`)

Kept unchanged:

- `:62`, `:98`
- `:147` (wiring: `SignIn` is handed `amr`)
- `:170` (`signInFailed` event)
- `:227` (CSD-003)
- `:308` (WPS-001)
- `:502`, `:515`, `:603`, `:610`
- `:710`, `:730`, `:768`, `:803` (freshness, step-up refresh, BEH-EA-319)

**`PasskeyEnumeration.test.ts`**, added: `WPS-005 admission: an authenticate/verify throttled by the per-source budget leaves the challenge live` (pins Q1). Kept: TC-001 ×6, WPS-005 ×4.

**Kept as they are:**

- `PasskeyUserHandle.test.ts`: minting `:31`, `:60`; signals; the store suite.
- `PasskeyAttestation.test.ts`: the warning cases `:153`, `:163`. It becomes a 2-case file for the build-time warning; keep it, since the warning is a boot concern.
- `PasskeyTenantConfig.test.ts` (2), `PasskeyRealPort.test.ts` (6), `AuthHttp.test.ts`, `ChallengeStore.test.ts`, `PasskeyCredentials.test.ts`, `PasskeyErasure.test.ts`, `PasskeyStoreOutage.test.ts`, `Contract.test.ts`, `AuthComposition.test.ts`.

### 5.3 BDD

- Added in Phase 0: the REQ-EA-`<next>` scenario (§4 Phase 0 item 4).
- Unchanged in meaning: REQ-EA-355..381, 696, 1007..1024. REQ-EA-364..366 still pass: their first attempts fail after the claim, as before.
- The `PasskeyRpIdMismatch`/`PasskeyOriginMismatch` failure-tag rows (`PasskeySteps.ts:1123-1126`) use fresh options per call, so they are unaffected by the precedence change.

### 5.4 Tests deleted or moved, by name

Every case below is replaced by the §5.1 case named in parentheses, or moved verbatim (§5.2).

- **`PasskeyCeremony.test.ts` (old).**
  - Replaced: WPS-003 ×2 (3); CB-002 ×3 (14, 15); CB-003 ×6 (9, 10, and the posture tables); MNA-007 ×3 (11, posture); TC-008 `:318`, `:330`, `:355`, `:387` (12, 13).
  - Moved to `Passkey.test.ts`: TC-008 `:407`, TC-003 ×3, CB-009, HSK-003, WPS-010.
  - The 10 Phase 0 rows are replaced by A1 (and the registration and sign-in posture rows).
- **`Passkey.test.ts`.**
  - "HSK-005: a synced (multiDevice) passkey with user verification records swk+user" and "HSK-005: a device-bound passkey without user verification records hwk alone" (32).
  - "a replayed or expired challenge is rejected as PasskeyChallengeInvalid" (A1, posture).
  - "Missing required user verification is rejected as PasskeyUserVerificationRequired" (26).
  - "a counter regression is flagged via AuthEvents without failing the ceremony" (27).
  - "register/verify rejects a response asserting the wrong origin" (7, posture).
  - "registerOptionsConditional's own challenge completes register/verify with UP=0/UV=0 accepted" (15).
  - Both "CB-001: register/verify via the ordinary scope …" (16).
  - "reauthenticateVerify requires user verification unconditionally" (26).
  - "reauthenticateVerify refuses a credential belonging to a different user" (23, step-up posture).
  - "BEH-EA-136: an unknown credential id at authenticate/verify answers uniform InvalidCredentials" (22, sign-in posture).
- **`PasskeyCounterAnomaly.test.ts`.** The whole file (8 cases → 27-31).
- **`PasskeyEnumeration.test.ts`.** Both TSS-004 cases (22, 24).
- **`PasskeyUserHandle.test.ts`.** "an assertion whose userHandle matches …", "… without a userHandle …", "… differs …", and "step-up reauthentication cross-checks the userHandle too" (25, posture).
- **`PasskeyAttestation.test.ts`.** The five `HSK-002: attestationPolicy` cases (17-20).

Net: about 47 plugin-level cases out, about 33 ceremony cases in (A1 counts as one table), 3 posture tables, 2 admission cases.

---

## 6. Spec, ADR, traceability and changesets

### 6.1 Behaviour specs: `spec/behaviors/17-passkey.md` → revision 1.4

Change history line: "1.4 (`<date>`): BEH-EA-132 states the step order: every ceremony spends its challenge first, even when the client data is unreadable; admission refusals precede the attempt; a refused challenge outranks every other refusal. One implementation (`PasskeyCeremony`) for registration, sign-in and step-up; step-up pays the TSS-004 decoy verification (architecture plan 12)."

- **Status banner** (`:15`): add `PasskeyCeremony.ts` and `PasskeyConfig.ts` to the file list.
- **BEH-EA-132**
  - Add to the REQUIREMENT block (after `:115`): "The challenge MUST be spent before any other check of the attempt, so that no refusal leaves it usable."
  - Add after `:120` (Phase 0 writes the first three sentences; Phase 3 adds the module sentence): "**Step order.** Every ceremony spends the challenge of its scope first: before the origin check, the `WebAuthn` port or any credential lookup, and even when the browser's `clientDataJSON` cannot be read, since the scope comes from the session or the `ceremonyId`, never from the client data. A refused challenge therefore outranks every other refusal. A request refused *before* verification starts is not an attempt and leaves the challenge alone: an `authenticate/verify` over its per-source budget, a `register/verify` from a session older than `reauthMaxAgeSeconds` (BEH-EA-255, so the same response can be presented again after a step-up), and an unsupported token-delivery header. One module, `PasskeyCeremony`, implements the order for registration, sign-in and step-up (plan 12)."
- **BEH-EA-133** (after `:139`): "The origin check runs after the challenge is spent (BEH-EA-132), in the one implementation all three ceremonies share."
- **BEH-EA-131**, counter paragraph (`:96`): replace "Step-up reauthentication applies the same policy." with "Step-up reauthentication applies the same policy, in the same implementation."
- **BEH-EA-136** (`:199`): after "an unknown credential id still costs one signature verification against a decoy key", add "(at step-up too, where a credential the caller does not own is answered `PasskeyCredentialNotFound` after the same decoy verification)". Also add: "Each endpoint's mapping from a ceremony refusal to its wire error is one total record, checked by the compiler."

`spec/glossary.md` → next revision (1.6 at `fc990c88`). Add after `### VerificationToken` (`:49-51`):

> ### Passkey ceremony
>
> One registration (modal or conditional), sign-in or step-up exchange of a WebAuthn challenge for a browser response. Its kind decides the challenge scope (`passkey.register[.conditional]:<sessionId>`, `passkey.authenticate:<ceremonyId>`, `passkey.reauthenticate:<sessionId>`). Verification spends the challenge first, then checks the origin, the signature and the kind's policy (user verification, attestation, user handle, signature counter), and answers a verified credential or a refusal reason. How precisely an endpoint reports a refusal is its posture. See: [BEH-EA-132](behaviors/17-passkey.md#beh-ea-132-challenges-are-single-use-and-short-lived), [BEH-EA-136](behaviors/17-passkey.md#beh-ea-136-typed-errors-are-enumeration-safe).

### 6.2 Decisions

No new ADR and no amendment. The plan implements BEH-EA-130..136 as written and makes BEH-EA-132's order explicit; that is behaviour text, not an architectural decision. ADR-EA-010 (ports), ADR-EA-013 (error taxonomy: the new internal tags are prefixed), ADR-EA-018 decision 8 (config in force, which the endpoints still read per operation and hand to the ceremony) and ADR-EA-028 (`StoreUnavailable` propagates untouched) all hold unchanged.

### 6.3 Traceability

`spec/traceability.md` (next revision; the change-history line names plan 12):

- `:43` (§1, 17 Passkey): implementation cell `@awthaq/passkey/src/Passkey.ts, PasskeyCeremony.ts`.
- `:251` (`Passkey.test.ts`): drop "a wrong-origin/wrong-rpId registration response rejected before the port is ever called", the replay, UV, counter and Conditional Create clauses. Add "the three endpoint postures (BEH-EA-136): one table per endpoint from every ceremony refusal to its wire error; admission (BEH-EA-255) leaves the challenge usable; the options-side TC-003/CB-009, persisted transports (HSK-003) and duplicate ids (WPS-010)".
- `:252` (`PasskeyCeremony.test.ts`): rewrite as "BEH-EA-130..133/135/136/256/257 at `PasskeyCeremony`'s interface over `Passkey.records.memory` and `.sql` (no `Users`/`Sessions`), `WebAuthn` mocked: the step order (every attempt spends its challenge first, for every kind and refusal, BEH-EA-132), the stable scope strings, the one origin policy (CB-003, MNA-007, TC-008), registration UP/UV/attestation (CB-001/002, HSK-002/003), assertion decoy cost (TSS-004, sign-in and step-up), user handle (BPAS-003), UV per kind, counter policy (CB-004, WPS-006), `amr` (HSK-005), and outages as `StoreUnavailable`".
- `:253` (`PasskeyCounterAnomaly.test.ts`): delete the row.
- `:254` (`PasskeyEnumeration.test.ts`): drop "an unknown credential id still calling `verifyAuthentication`"; add "a throttled `authenticate/verify` leaves its challenge live".
- `:255` (`PasskeyAttestation.test.ts`): "the single build-time warning when conveyance is requested with no policy (the policy itself is tested in `PasskeyCeremony.test.ts`)".
- `:256` (`PasskeyUserHandle.test.ts`): drop "the `userHandle` cross-check on sign-in and step-up".
- `:356` (§6 crosswalk, `17-passkey.feature`): add the new REQ id and bump the count `54 / 54` → `55 / 55`.
- `features/traceability.md`: regenerated by `allocate-req-ea.py` in Phase 0.

### 6.4 Changesets (ADR-EA-034)

Phase 0, `.changeset/passkey-challenge-spent-every-attempt.md`, `"@awthaq/passkey": patch`:

> `register/verify` and `reauthenticate/verify` now spend the ceremony's challenge before checking the origin, and every ceremony (sign-in included) spends it when the browser's `clientDataJSON` cannot be read, so no refused verification attempt leaves its challenge usable (BEH-EA-132). A missing or spent challenge now outranks an origin refusal at registration and step-up (`PasskeyChallengeInvalid`, as sign-in already answered).
>
> Migration: a client that presented the same challenge again after `PasskeyOriginMismatch` or `PasskeyRpIdMismatch` must request fresh options first (`@awthaq/client`'s `passkeyClient` never retries). Requests refused before verification (rate-limited, stale session, bad token-delivery header) are unaffected: their challenge stays usable.

Phases 1-3 carry no changeset: no package-visible change, since the `Passkey` namespace keeps `config`, `PasskeyConfig`, `PasskeyConfigShape` and `AttestationPolicy` through re-exports, and `PasskeyCeremony` is not exported. If an execution finds otherwise (for example `pnpm package:smoke` flags a changed declaration), add a patch changeset naming it.

---

## 7. Risks, mitigations, rollback

| Risk | Mitigation |
|---|---|
| **A client retries with the same challenge after an origin refusal** and now fails | That retry was the bug. The changeset's `Migration:` line says so. `passkeyClient` does not retry (`packages/client/src/passkey/PasskeyClient.ts` maps errors only). A real user's browser cannot change its origin between attempts anyway |
| **Error precedence shift** (`PasskeyChallengeInvalid` before `PasskeyOriginMismatch`) surprises an operator diagnosing a misconfigured origin with an expired challenge | The next attempt with fresh options reports the origin. BEH-EA-132's text states the precedence. Q2 offers the alternative |
| **A test depends on the old order** | Only `Passkey.test.ts:533` (fixed in Phase 0). BDD helpers issue fresh options per origin check. Phase 0 runs `pnpm test` and `pnpm test:bdd` in full |
| **Declaration emit cannot name a type** (TS2883, plan 04 phase 0) once helpers leave `Passkey.ts` | The postures and the `make` result are internal, and `Passkey.layer`'s inferred type exposes only its requirements, which are unchanged. If emit complains, keep the namespace imported in `Passkey.ts` (plan 04's fix) |
| **`Brand.Branded` over an object schema type** fails to infer | Use the interface form in §3.4's notes; behaviour is unchanged |
| **A type cycle** `Passkey.ts ↔ PasskeyCeremony.ts` | `PasskeyCeremony` never imports `Passkey.ts` (config comes from the Phase 1 leaf). `pnpm circular` runs type-inclusive |
| **Custom `ChallengeStore` implementations** that compare before deleting would not spend on `NO_CHALLENGE` | That breaks the existing interface contract (`ChallengeStore.ts:82`: "the entry gone either way"). BEH-EA-132's text now says the store must pop by scope. The stateless `layerCookie` has nothing to spend and claims `singleUse: false` already (WPS-009) |
| **The step-up decoy adds latency** | One ES256 verification, only for an unknown or foreign credential. Q3 can drop it |
| **Plans 11 and 22 conflict textually** in `Passkey.ts` | Disjoint regions (§8). Whichever lands second re-anchors line numbers |

**Rollback.**

- Phase 0 is a self-contained reorder plus tests. Reverting it restores the bug, so roll it back only with a replacement fix.
- Phase 1 is a pure move and reverts cleanly.
- Phase 2 reverts as a unit (the module, the endpoints and the tests together). After that revert, Phase 0's hotfix lines are back, so the bug stays fixed.
- Phase 3 is documentation.

---

## 8. Interactions with other plans

**Plans 01-10 (merged):**

- **01** (`SignIn`, `SessionDelivery.respond`): the sign-in endpoint keeps `signIn.complete` and the `SignIn/UserGone` mapping. `SessionDelivery.respond`'s mode check stays admission, before the attempt.
- **05** (store failures): the ceremony propagates `StoreUnavailable` from `ChallengeStore`/`PasskeyCredentials` untouched (§5.1 case 33).
- **06** (rate-limit budget): `authenticateVerifyByIp` stays spent before the attempt (admission, `Passkey.ts:1462`). Nothing moves into the ceremony. The plan only states in BEH-EA-132 that a throttled request does not spend the challenge.
- **07** listed the passkey `ChallengeStore` as "burns by spec (BEH-EA-132)" in its non-goals (`.planning/07-verification-redeem/PLAN.md:40`). After this plan that is true of all three ceremonies.
- **08** (`Passkey.records`): the ceremony suite composes from `Passkey.Passkey.records.memory`/`.sql`. The bundle is unchanged, and `runPluginContractTests` (`Contract.test.ts`) is unaffected.
- **09** (event definitions): `auth.passkey.counterAnomaly` is published unchanged, now from `PasskeyCeremony`.
- **10** items 3, 4 and 6: `Sessions.reauthenticate`'s 401 and `requireFresh` stay in the endpoints; the retention contribution is unchanged.

**Sibling plans 11-24:**

- **11 (credential resolution).** It replaces `currentUserPrincipal` (`Passkey.ts:617-627`) and `IssuedSession` (`:494-497`) with shared helpers. That region is disjoint from this plan's edits, so either order works.
- **15 (host composition).** `passkeyTestLayers.ts` builds on `TestAuth.layer`; the new ceremony suite does not. If 15 changes `TestAuth.layer`'s options, only `buildLayer` adapts.
- **20 (in-process user agent).** The Phase 0 BDD steps use `PasskeySteps`' `request` helper. If 20 lands first, they use its agent. No semantic interaction.
- **21 (session-minting annotation).** It annotates `authenticate/verify` as minting a session. The endpoint's contract is unchanged here.
- **22 (table DDL locality).** It moves `passkeyMigrations` (`Passkey.ts:803-958`) next to the three records modules. This plan does not touch `:803-958`. Phase 1's comment fix at `:960-966` is skipped if 22 got there first. Either order works; coordinate only on line anchors.
- **24 (memory records over SQLite).** If the passkey memory bundle becomes SQLite-backed, the ceremony suite follows automatically, because it uses `Passkey.Passkey.records.memory`, not `ChallengeStore.layerMemory` directly.
- **12, 13, 14, 16, 17, 18, 19 and 23.** No interaction (no shared module).

---

## 9. Acceptance checklist

- [ ] Phase 0's 10 rows were red before the hotfix and are green after it. The new BDD scenario passes.
- [ ] `PasskeyConfig.ts` exists. `Passkey.config`, `Passkey.PasskeyConfig`, `Passkey.PasskeyConfigShape` and `Passkey.AttestationPolicy` still resolve, and `index.ts` is unchanged.
- [ ] `PasskeyCeremony.ts` exports `Ceremony`, `scopeOf`, `CeremonyPolicy`, `RegistrationRefusal`, `AssertionRefusal`, `RegistrationRefused`, `AssertionRefused`, `Posture`, `VerifiedAssertion`, `isHttpsOrigin` and `make`, and nothing outside the package imports it.
- [ ] The origin check and the port calls take a `Claimed`, which only `claim` constructs.
- [ ] `Passkey.ts` has three `satisfies PasskeyCeremony.Posture<…>` records. The `PasskeyShape` error unions (`:499-614`) are byte-identical to `fc990c88`.
- [ ] The §4 Phase 3 greps return nothing. There is no `as` (other than `as const`), and no return-type annotation on a new Effect const.
- [ ] The §5.1 suite passes over `records.memory` and `records.sql` (SQLite, and Postgres under `pnpm test:pg`, with the file in `scripts/test-pg.sh`).
- [ ] `PasskeyCounterAnomaly.test.ts` is deleted, and every case in §5.4 is gone from its old file.
- [ ] BEH-EA-131/132/133/136 are updated (`17-passkey.md` at rev 1.4). The glossary has "Passkey ceremony". `spec/traceability.md` and `features/traceability.md` are updated, and `pnpm spec:verify:strict` passes.
- [ ] `packages/passkey/README.md` has the BEH-EA-132 bullet and no stale "Limits" bullet.
- [ ] The Phase 0 changeset exists with its `Migration:` line.
- [ ] `pnpm check && pnpm test:pg` is green on the final commit.

---

## 10. Open questions only the user can answer

1. **Does an admission refusal spend the challenge?** Today, and in this plan, a request refused before verification starts leaves the challenge usable. That covers a stale session at `register/verify`, an `authenticate/verify` over its per-IP budget, and a bad token-delivery header. BEH-EA-132 is amended to say so.
   - **Recommended: yes, admission precedes the attempt.** BEH-EA-255's flow then works as written: the browser already produced a credential bound to that challenge, so after the step-up the same response can be presented again instead of leaving an orphaned credential in the authenticator. It also mirrors plan 06's budget-first order.
   - The alternative spends it there too, by moving the freshness check after the claim. The plan's two admission tests then flip.
2. **Precedence when both the challenge and the origin are wrong.** Spending first makes registration and step-up answer `PasskeyChallengeInvalid` where they answered `PasskeyOriginMismatch`.
   - **Recommended: accept it.** It is one rule for all three ceremonies, and sign-in already behaves this way.
   - The alternative still spends first but *reports* an origin refusal ahead of a failed claim at the two authenticated endpoints. That is one extra branch in `verifyRegistration`/`verifyAssertion`, keyed by kind.
3. **Should step-up pay the TSS-004 decoy verification** for an unknown or foreign credential, so "a credential this ceremony may not use costs one verification" is one rule?
   - **Recommended: yes.** It is one branch instead of two, and costs one ES256 verification on a refusal path.
   - "No" keeps today's cheaper path; Phase 2 item 6 says what to drop.
4. **Should options generation also move into `PasskeyCeremony`?** That covers the creation/request options, `excludeCredentials`, the TC-001 decoy `allowCredentials` and `ceremonyKnobsOf`, which would then own the whole options half rather than only `begin`.
   - **Recommended: no, not in this plan.** The options inputs differ per endpoint (user lookup, user handle, decoys keyed by a boot-scoped secret, `Users.findByEmail`). Moving them would give the ceremony module `Users` and `PasskeyUserHandles` dependencies for no caller beyond today's, and the bug class here is on the verify half. Revisit if a fourth ceremony kind appears.
