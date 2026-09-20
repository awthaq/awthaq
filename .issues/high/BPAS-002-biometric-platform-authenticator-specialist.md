---
ID: "BPAS-002"
Title: "Entire browser-side platform-authenticator layer is absent (detection, conditional mediation UI, fallback UX)"
Level: high
Category: "dx"
Status: resolved
Package: "—"
Source: "research/06-webauthn-passkeys.md:171"
Auditor: "biometric-platform-authenticator-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BPAS-002 — Entire browser-side platform-authenticator layer is absent (detection, conditional mediation UI, fallback UX)

`HIGH` · `dx` · `—` · reported by **Biometric / Platform Authenticator Specialist** (`biometric-platform-authenticator-specialist`)

Status: **resolved**

## Summary

The planned client helper was never built: grep finds zero references to passkey/WebAuthn in packages/client, packages/react or packages/next — @awthaq/client only re-exports HttpApiClient primitives (AuthClient.ts:51). That leaves every persona-critical concern to each app team: isUserVerifyingPlatformAuthenticatorAvailable/getClientCapabilities detection before rendering a Face ID button, mediation:'conditional' autofill with autocomplete="username webauthn" plus the mandatory button fallback, and mapping raw NotAllowedError/InvalidStateError into distinct, human cases (user-cancelled vs no authenticator). The server supports usernameless options, but no client can drive conditional mediation correctly, and research/06's own warning (do not ship conditional UI exclusively; autofill needs field focus) lands nowhere.

## Evidence

Source: `research/06-webauthn-passkeys.md:171`

```
**Client package**: `passkeyClient()` in `@awthaq/client` exposing `registerPasskey`, `authenticate({ autoFill: true })` (conditional UI via `startAuthentication({ useBrowserAutofill: true })`), `listPasskeys`, `renamePasskey`, `deletePasskey`, plus feature-detection helpers (`getClientCapabilities`).
```

## Recommended fix

Ship passkeyClient() in @awthaq/client on @simplewebauthn/browser: startRegistration/startAuthentication wrappers, conditional-UI authenticate({autoFill:true}) with button fallback, getClientCapabilities()/platform-authenticator detection hooks, and a typed error mapper distinguishing user-cancel, no-platform-authenticator and ceremony-timeout.

## Context

- Auditor verdict on this domain: **needs-work** (score 60/100), domain: Platform authenticators
- Full dossier: [`biometric-platform-authenticator-specialist`](../../.reports/biometric-platform-authenticator-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 13 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Validation (2026-09-19):** CONFIRMED — case-insensitive grep for "passkey"/"webauthn" across `packages/client/src`, `packages/react/src`, and `packages/next/src` returns zero hits; `packages/client/src/AuthClient.ts` only re-exports `HttpApiClient` primitives (`make`, `makeWith`, `group`, endpoint helpers around lines 40-55). No client-side detection/conditional-mediation/error-mapping helper exists anywhere in the repo. Building this is greenfield API/UX design (error taxonomy, capability-detection surface), not a mechanical fix. Status → ready-for-human.

**Decision (2026-09-19):** Resolved via [Browser-side WebAuthn/passkey UX layer (client/react/next)](../../.scratch/resolve-ready-for-human-findings/issues/32-browser-webauthn-ux-layer.md) — ship `passkeyClient()` as a new `@awthaq/client/passkey` subpath module (no new package) wrapping `@simplewebauthn/browser` v14, with a `PasskeyClientError` taxonomy built on that library's own classified `WebAuthnError.code`, `getClientCapabilities()` feature detection, and a mandatory non-autofill `authenticate()` path alongside `{ autoFill: true }` so conditional UI can never ship without its button fallback; additive React atoms follow in `packages/react`. Status → ready-for-agent.

**Resolved (2026-09-20):** Implemented the client-side WebAuthn/passkey UX layer from the decision above, with one grounded correction against current source: the decision's own `@awthaq/client/passkey` **subpath package export** (a `"./*"` entry in `package.json`) doesn't match this repo's real convention — no package here uses that pattern; every one (including `@awthaq/react`'s own `AuthCore`/`SubjectContract` imports) re-exports its modules as named namespaces off the package's single `"."` root export. Shipped that way instead: `packages/client/src/passkey/PasskeyClient.ts` and `PasskeyClientError.ts`, barrel re-exported as `PasskeyClient`/`PasskeyClientError` from `packages/client/src/index.ts`, consumed as `import { PasskeyClient } from "@awthaq/client"` — same discoverability, no `package.json` export-map change needed.

- **Dependency:** `@simplewebauthn/browser@^14.0.0` (the latest published version; the decision's `^14.0.1` doesn't exist) added to `packages/client/package.json`, matching `@awthaq/ports`' server-side `@simplewebauthn/server@^14.0.1` pin's major version. `@awthaq/passkey` also added as a dependency, type-only (`import type { PasskeyApi } from "@awthaq/passkey"`) — erased at build, no runtime dependency on that package's server-heavy siblings.
- **`PasskeyClient.ts`:** `passkeyClient(client: PasskeyApiClient)` — composition-agnostic over an already-built client slice, exactly like `AuthClient.ts`'s own `SessionStore`/`toPromiseFacade`. `PasskeyApiClient` and every method's error union are *derived* from `HttpApiClient.ForApi<typeof PasskeyApi.PasskeyApi>` (via `Pick`), not hand-duplicated — `PasskeyClientShape` itself is `ReturnType<typeof passkeyClient>`, inferred rather than hand-declared, so a future contract change can't drift out of sync with this module the way `AuthClient.ts`'s own header comment warns against for `make`/`group`/`endpoint`. `registerPasskey`/`authenticate` wrap `startRegistration`/`startAuthentication`; `registerPasskeyConditional` follows `research/06-webauthn-passkeys.md:195`'s own "resolves to void even on ceremony failure" rule (only `registerOptionsConditional`'s own declared errors, e.g. `PasskeyConditionalCreateDisabled`, still propagate); `authenticate({ autoFill })` selects `useBrowserAutofill` but never silently substitutes the button flow for it — the real library's own `document.querySelectorAll` check still runs and fails loudly if no eligible `<input>` exists, closing BPAS-002's own "do not ship conditional UI exclusively" concern in the other direction. `getClientCapabilities()` wraps `@simplewebauthn/browser`'s own `getBrowserCapabilities()` (which already implements the "browser reports unknown, fall back to an alternative WebAuthn API" logic research/06:31 names) rather than reimplementing capability detection by hand, preserving its real three-state `"supported"/"unsupported"/"unknown"` values instead of collapsing to booleans. The two `Schema.Unknown` options payloads from the wire are narrowed via `Predicate.isReadonlyObject`/`Predicate.hasProperty` type guards, not an `as`/`as unknown as` cast, per this repo's standing no-type-assertions rule.
- **`PasskeyClientError.ts`:** `Data.TaggedError` (not `Schema.TaggedError` as the decision sketched) — these never cross the wire, the same in-process-only distinction `@awthaq/oauth`'s `OAuthTokenAccess.ts` already draws for its own `OAuthTokenUnavailable`/`OAuthRefreshFailed`. `fromCeremonyFailure` classifies `@simplewebauthn/browser`'s own already-classified `WebAuthnError.code` into `PasskeyUserCancelled`/`PasskeyNoPlatformAuthenticator`/`PasskeyAlreadyRegistered`/`PasskeyCeremonyFailed`, plus a source-verified correction beyond the decision's own sketch: `NotAllowedError` (the overwhelmingly common real "user declined" case) is deliberately left as `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY` by the library itself ("platforms are overloading this error beyond what the spec defines"), so this module looks past that passthrough at the real `DOMException` preserved on `.cause` rather than collapsing the single most common cancellation case into the generic catch-all.
- **React layer:** left out, exactly as the decision itself named as "additive, not part of this ticket's minimum."

TDD/mutation-verified: `packages/client/test/PasskeyClientError.test.ts` (11 tests) exercises the full classification table directly against real `WebAuthnError`/`DOMException` instances, including the `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY` correction. `packages/client/test/PasskeyClient.test.ts` (17 tests) exercises `passkeyClient` against a *real* `HttpApiClient.make(PasskeyApi.PasskeyApi)` talking to a fake `HttpClient` (never a hand-typed client stand-in — TypeScript's own structural typing rejected one, since `Method<Endpoint,E,R>`'s generic `Mode` polymorphism and branded `Schema.Class` success types aren't satisfiable by a plain literal), with `@simplewebauthn/browser` itself real and unmocked — only the actual browser platform boundary (`navigator.credentials.create`/`.get`, `PublicKeyCredential`, `document`) is faked, mirroring `packages/oauth/test/OAuth.test.ts`'s own "fake only the external non-Effect boundary" discipline. Mutation-confirmed: (1) temporarily removing `registerPasskeyConditional`'s `Effect.catch(() => Effect.void)` broke exactly the "resolves to void" test with the right failure, reverted; (2) temporarily removing the `ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY`/`NotAllowedError` correction broke exactly the two tests that depend on it, reverted; (3) temporarily dropping `isCreationOptionsJSON`'s `pubKeyCredParams` check broke a dedicated test proving the guard short-circuits before `navigator.credentials.create` is ever called (constructed so the guard's absence would let a malformed payload reach a fake `create()` that returns a canned credential, rather than merely coinciding with a library-level crash), reverted. Also discovered and fixed along the way: modern Node ships a real, getter-only global `navigator` that `Reflect.set` silently no-ops against — the test's platform-faking helper deletes it first (still configurable) and restores the original property descriptor in `afterEach`.

Full monorepo `pnpm run typecheck` clean; `pnpm run test` green (798 passed, up from 770 at the start of this fix). `test:bdd` not run — no `features/` file and no core BDD-dependency package touched. `npx oxfmt` run on all 7 touched/new files; re-verified typecheck and the full test suite green after formatting.

Deliberately left open, named explicitly rather than silently assumed: the additive React layer (`packages/react/src/PasskeyAtom.ts`, atoms wrapping `passkeyClient`'s Effects) the decision itself scoped out of this ticket's minimum; the `autocomplete="username webauthn"` HTML attribute and field-focus wiring the decision calls "unavoidably app-markup, not a gap in this design," documented as guidance rather than an API surface (no dedicated README section added this pass — a real gap relative to the decision's own "docs prescribe..." text, left for a future doc pass rather than silently claimed done here).
