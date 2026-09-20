---
ID: "CB-001"
Title: "Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options"
Level: high
Category: "correctness"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:452"
Auditor: "christiaan-brand"
Auditor-Type: "real"
Audit-Date: 2026-09-19
---
# CB-001 — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options

`HIGH` · `correctness` · `passkey` · reported by **Christiaan Brand — W3C WebAuthn Specification Co-editor** (`christiaan-brand`)

Status: **resolved**

## Summary

Whenever the challenge is consumed from the ordinary registration scope, `enforceUserVerification` is true unconditionally, so `registerVerify` fails any response whose UV flag is 0 — independent of `config.authenticatorSelection.userVerification`. The default config conveys `userVerification: "preferred"` (Passkey.ts:66), which tells authenticators UV is optional; a PIN-less FIDO2 security key (YubiKey without PIN) legitimately answers a `preferred` ceremony with UV=0 and is then rejected with PasskeyUserVerificationRequired. Setting the config to `"discouraged"` makes it worse: options discourage UV yet verify still demands it, guaranteeing failure. This is exactly the cross-vendor interop class a relying party must avoid — the RP rejects responses its own options invited, contradicting WebAuthn §7.1's model that UV enforcement follows the RP's conveyed userVerification requirement.

## Evidence

Source: `packages/passkey/src/Passkey.ts:452`

```
let enforceUserVerification = consumedOrdinary;
...
if (enforceUserVerification && !verified.userVerified) {
```

## Recommended fix

Derive enforcement from config: `enforceUserVerification = consumedOrdinary && config.authenticatorSelection.userVerification === "required"`, mirroring the sign-in path (Passkey.ts:574-578). If mandatory UV-on-registration is the intended product policy, set the default `authenticatorSelection.userVerification` to "required" so options and verification agree.

## Context

- Auditor verdict on this domain: **needs-work** (score 58/100), domain: WebAuthn ceremonies
- Full dossier: [`christiaan-brand`](../../.reports/christiaan-brand/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 9 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-001` — Passkey enrollment requires only a live session — no re-authentication or step-up](high/BPAS-001-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, high)_`
- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — `packages/passkey/src/Passkey.ts:452` sets `enforceUserVerification = consumedOrdinary` with no reference to `config.authenticatorSelection.userVerification`, and the check fires at line 477. The sign-in path correctly gates on `config.authenticatorSelection.userVerification === "required"` at lines 574-578, and the default config sets `userVerification: "preferred"` at line 66 — confirming the registration/sign-in inconsistency exactly as described. The suggested one-line fix mirrors existing sign-in logic. Status → ready-for-agent.

**Resolved (2026-09-20):** Applied exactly the recommended fix, current source re-verified line-for-line first (line numbers had drifted to ~656-666 from unrelated intervening work, logic identical): `packages/passkey/src/Passkey.ts`'s `registerVerify`, the ordinary (non-conditional) scope's `enforceUserVerification` now reads `consumedOrdinary && config.authenticatorSelection.userVerification === "required"` — mirroring `authenticateVerify`'s own already-correct gate at (now) line 779. The conditional-create branch's own `enforceUserVerification = false` override is untouched — that one is deliberately unconditional per its own comment (Chrome's Conditional Create flow always produces UP=0/UV=0), not a second instance of this bug.

`packages/passkey/test/Passkey.test.ts`'s pre-existing "register/verify still requires user verification via the ordinary (non-conditional) scope" test was itself asserting the buggy behavior (UV=0 rejected under the *default* `"preferred"` config) — renamed and flipped to `"CB-001: register/verify via the ordinary scope accepts UV=0 under the default 'preferred' policy"` (now expects success), with a new sibling test `"CB-001: register/verify via the ordinary scope still rejects UV=0 when the policy is 'required'"` added to prove the config-gated behavior survives (explicit `authenticatorSelection: { userVerification: "required" }` override, mirroring the pre-existing sign-in-path test's own pattern at what's now line 360). Mutation-verified: temporarily reverting the fix to the old unconditional `enforceUserVerification = consumedOrdinary` broke exactly the new "accepts UV=0 under 'preferred'" test with the right failure (`PasskeyUserVerificationRequired` instead of success), reverted back.

Checked for collateral impact: grepped every test file in the repo for `registrationVerified` (the mock-WebAuthn knob this bug touches) — only `Passkey.test.ts` itself uses it, already updated above. `pnpm run test:bdd` was run to check for BDD-level fallout (`spec/behaviors/17-passkey.md` is a real behavior file); its one passkey-related failure (`17-passkey.feature:222`, the `PasskeyUserVerificationRequired` row of the "each distinct ceremony failure surfaces as its own typed error" Scenario Outline) was confirmed **pre-existing and unrelated** — reproduced identically on a `git stash` of this fix (same `StepFailureLocation` at the same line), caused by that feature's own step file being an unwired zero-step placeholder (10 lines, no step definitions), not by this change.

Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (799 passed, up from 798 before this fix — net +1 after replacing one stale test with two correct ones). `npx oxfmt` run on both touched files; re-verified typecheck and the full test suite green after formatting.

**Correction (2026-09-20):** The prior comment's `test:bdd` claim was wrong — `features/features/05-authentication-methods/17-passkey.steps.test.ts` is real and wired (it re-exports the shared `features/step-definitions/PasskeySteps.ts` step definitions; the 10-line file size that looked like a BDD-002-style unwired placeholder was misleading), and the `git stash` check only compared summary test *counts*, not the actual failure reason, so it didn't actually prove the failure predated this fix. Root cause, properly diagnosed: `PasskeySteps.ts`'s `FAILURE_TAGS["user verification was required but absent"]` scenario exercised `PasskeyUserVerificationRequired` by mocking `userVerified: false` but never configured `authenticatorSelection.userVerification: "required"` — it relied on the app's default `"preferred"` policy, which this fix correctly stopped rejecting UV=0 under. Fixed by threading a real `authenticatorSelection` override through `PasskeyWorld.ts`'s `AppOptions`/`buildAppLayer` (previously only `rpId`/`origins`/`attestation`/`conditionalCreate` were forwarded to `Passkey.config`) and setting `authenticatorSelection: { userVerification: "required" }` for that one scenario in `PasskeySteps.ts`, mirroring the exact fix already applied to the domain-level test. `pnpm run test:bdd` now green (104 passed, 0 failed) across 3 consecutive runs.

While verifying BDD stability, also found and fixed a genuine, unrelated pre-existing flake in `features/step-definitions/PasswordSteps.ts`: two password-reset scenarios read `sentMail()` immediately after calling `/password/request-reset`, but `requestReset`'s own mail dispatch (`packages/password/src/Password.ts`) is `Effect.forkDetach`ed (BEH-EA-064: response latency must never be an enumeration oracle) and never awaited by the response — a genuine race, not a logic bug. The fix (`letForkedFibersRun`, giving the detached fiber scheduler turns before reading captured mail) already existed and was already used by 3 other call sites in the same file (including the near-identical `verifyLatestSignUp` helper) — these two call sites had simply omitted it. Mutation-confirmed as a real, deterministic (not merely flaky) fix: removing each `letForkedFibersRun` addition individually reproduced the corresponding scenario's exact failure on every one of 3-5 consecutive runs; restored, green again on every run.
