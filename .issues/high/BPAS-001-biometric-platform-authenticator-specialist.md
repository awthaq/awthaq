---
ID: "BPAS-001"
Title: "Passkey enrollment requires only a live session — no re-authentication or step-up"
Level: high
Category: "security"
Status: resolved
Package: "passkey"
Source: "packages/passkey/src/Passkey.ts:433"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-001 — Passkey enrollment requires only a live session — no re-authentication or step-up

`HIGH` · `security` · `passkey` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

registerVerify runs from the session principal alone (currentUserPrincipal) with no proof of recent credential possession. A hijacked session cookie — or any XSS — can silently enroll an attacker passkey and convert a temporary session into durable account takeover; the conditional-scope path even accepts UV=0. The repo already has the right tool and uses it for a *less* sensitive operation: qadi ships a reauth(maxAgeSeconds) obligation with ReauthRequired (packages/qadi/src/Resolvers.ts:86-93) applied to changeEmail, yet passkey enrollment — the most persistent credential grant in the system — ignores it. research/06's own UX posture places enrollment at the highest-intent moment right after password login for exactly this reason.

## Evidence

Source: `packages/passkey/src/Passkey.ts:433`

```
const registerVerify: PasskeyShape["registerVerify"] = Effect.fnUntraced(
  function* (userId, sessionId, input) {
    const clientDataOpt = decodeClientData(input.credential.response.clientDataJSON);
```

## Recommended fix

Gate registerOptions/registerVerify behind the existing awthaq/reauth obligation (or require the conditional-create challenge to be scoped to a session whose lastAuthAt is recent), so stale or stolen sessions must re-prove a credential before adding a passkey.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Related findings (same source file)

- [`BPAS-003` — webauthnUserId is re-randomized per ceremony and diverges from the credential's real userHandle](medium/BPAS-003-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-005` — Ordinary registration requests userVerification:preferred but unconditionally rejects UV=0 — dead-end UX](medium/BPAS-005-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`BPAS-006` — WebAuthn L3 Signals API entirely unimplemented — stale passkeys persist in credential managers](medium/BPAS-006-biometric-platform-authenticator-specialist.md) `_(biometric-platform-authenticator-specialist, medium)_`
- [`CB-001` — Ordinary registration enforces UV=required regardless of the userVerification policy conveyed in options](high/CB-001-christiaan-brand.md) `_(christiaan-brand, high)_`
- [`CB-003` — clientDataJSON crossOrigin flag is dropped end-to-end, accepting cross-origin iframe ceremonies](medium/CB-003-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-004` — Counter-anomaly "log + step-up" policy is unreachable — library hard-fails regressions first](medium/CB-004-christiaan-brand.md) `_(christiaan-brand, medium)_`
- [`CB-005` — Stored user handle never matches the handle bound into the credential; assertion userHandle ignored](low/CB-005-christiaan-brand.md) `_(christiaan-brand, low)_`
- [`CB-006` — authenticateOptions leaks account existence via allowCredentials population](low/CB-006-christiaan-brand.md) `_(christiaan-brand, low)_`
- … 16 more findings touch `packages/passkey/src/Passkey.ts`

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED (core claim), with one inaccuracy — `packages/passkey/src/Passkey.ts`'s `registerVerify`/`registerOptions`/`registerOptionsConditional` never reference `reauth`/`ReauthRequired`, confirmed by a repo-wide grep for `reauth(` outside `packages/qadi/src/Resolvers.ts`, which returns nothing: the "applied to changeEmail" comparison is misleading since no real `changeEmail` endpoint exists anywhere in the codebase (`Resolvers.ts:85`'s comment is illustrative only, "the duty a changeEmail-shaped handler obliges its caller to" — `reauth` is unused/unwired everywhere, not selectively skipped for passkey). The underlying gap (no step-up gate on passkey enrollment) is real and security-sensitive. Since there is no working precedent to mirror and the fix involves policy choices (which paths to gate, `maxAgeSeconds` threshold, UX friction trade-off), this needs human judgment rather than a mechanical port. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Step-up re-authentication mechanism (shared primitive)](../../.scratch/resolve-ready-for-human-findings/issues/15-step-up-reauth-mechanism.md) — Resolved via the same `authenticatedAt`/`Sessions.reauthenticate` primitive: passkey enrollment now gates behind a baked-in, fail-closed `PasskeyConfig.reauthMaxAgeSeconds` freshness check (mirroring the existing `canImpersonate` precedent), not left to an app-composed qadi policy. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented alongside [`AAPS-001`](AAPS-001-abac-attribute-policy-specialist.md) (same wayfinder ticket, shared primitive — see that finding's own resolution comment for the full `Sessions.authenticatedAt`/`reauthenticate`/`isStale` detail). This finding's own half, in `packages/passkey/src/{Passkey,PasskeyApi}.ts`:

- `PasskeyConfigShape` gains `reauthMaxAgeSeconds: Duration.Duration` (default 5 minutes, matching the `reauth(300)` example already in `@awthaq/qadi`'s own doc comments).
- `registerOptions`/`registerOptionsConditional`/`registerVerify` all call a new internal `requireFreshSession` check first — reads the caller's own `SessionListItem.authenticatedAt` (via `Sessions.list` + find, mirroring `@awthaq/qadi`'s `reauthHandler`) and compares it against `reauthMaxAgeSeconds` via `Sessions.isStale`, failing closed with a new `PasskeyReauthRequired` (`403`) error before doing anything else. Checked again at `registerVerify` time, not just `.../options`, to close the window between fetching options while fresh and presenting the completed ceremony after the session has since gone stale.
- New `passkey.reauthenticate` group (`POST /passkey/reauthenticate/options` + `/verify`): a normal WebAuthn authentication ceremony scoped to the caller's own already-live session (challenge keyed by session id, not an anonymous `ceremonyId` — there's always a session here, unlike `passkey.authenticate`), restricted to the caller's own credentials, requiring UV=1 unconditionally, calling `Sessions.reauthenticate` on success. Since this ceremony only ever runs for an already-authenticated caller re-proving their own credential (no identifier to enumerate), it reports the full, precise BEH-EA-136 taxonomy rather than collapsing into `Api.InvalidCredentials` — including a new `PasskeyCredentialNotFound` case when the presented credential belongs to a different user (defense against a confused-deputy presentation).

TDD: `packages/passkey/test/Passkey.test.ts` adds a dedicated "step-up reauthentication" suite — `registerOptions`/`registerVerify` refuse a stale session (`TestClock.adjust` past the 5-minute default); a full `reauthenticateOptions`→`reauthenticateVerify` round trip clears the gate for a subsequently-stale session without a new sign-in; `reauthenticateVerify` requires UV=1 unconditionally and refuses a credential belonging to a different user. Verified to genuinely fail: removing the `requireFreshSession` call from `registerOptions` reproduces options being issued instead of a `PasskeyReauthRequired` failure. Full monorepo `pnpm run typecheck` and `pnpm run test` both green (684 passed, 7 skipped).
