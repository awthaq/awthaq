# WebAuthn & Passkeys — Research

Research date: 2026-09-12. All versions/dates verified against primary sources as of this date.

## TL;DR

- **WebAuthn Level 3 is a W3C Recommendation (2026-08-25)** — the "passkey release". It adds the BE/BS backup flags, Conditional Get/Create, the Signals API, standard JSON (de)serialization helpers, `getClientCapabilities()`, AAGUID reporting without attestation, hints, and Related Origin Requests. Awthaq should treat L3 as the baseline spec, not L2.
- **Use `attestation: "none"` as the default** and design for unattested synced passkeys. Attestation (`direct`/`enterprise`) is a workforce/enterprise feature requiring FIDO MDS validation; keep it out of the v1 default path. L3's "AAGUID with no attestation" change lets us still show friendly credential-manager labels from the community AAGUID list.
- **Challenge handling is the #1 security pivot**: ≥16 bytes of CSPRNG entropy, stored server-side (or in a signed HttpOnly challenge cookie) bound to the ceremony, single-use, and deleted on verification even when verification fails. CVE-2026-30964 (web-auth/webauthn-lib) and YSA-2026-02 (Yubico java-webauthn-server) both show the failure mode class: *application-level identity/origin confusion around an otherwise-correct library*.
- **Origin validation must compare scheme + host + port exactly**; rpID is a registrable-domain suffix of the origin host (ports never part of rpID). `localhost` (with any port) is valid for dev.
- **Passkeys are synced credentials**: store BE (`credentialDeviceType`) and BS (`credentialBackedUp`) per credential at registration and update BS on each authentication; sync ecosystems are iCloud Keychain and Google Password Manager (with Samsung Pass as the Android wildcard).
- **Multi-credential per user is table design, not API design**: one `passkey` table FK'd to user, `excludeCredentials` at registration, `allowCredentials` at authentication, list/rename/delete endpoints, plus Signals API calls on delete to clean stale credentials in credential managers.
- **Conditional UI (passkey autofill) is the default login UX**, with a button fallback; Conditional Create (automatic passkey upgrades) is the default enrollment booster. Corbado's 2026 benchmark: CC-only deployments plateau ~20% passkey adoption, +manual prompts → ~40%, full best practice → 60–80%.
- **Do not implement the CBOR/COSE/attestation layer ourselves.** Use `@simplewebauthn/server` v14 (MIT, actively maintained, spec co-editor Matthew Miller is its author) behind an Effect service, mirroring SimpleWebAuthn's server/browser split with `@simplewebauthn/browser` in the awthaq client package — the same choice better-auth made.
- **Auth.js has joined Better Auth**; its experimental passkey provider was SimpleWebAuthn-based and adapter-fragmented — evidence that passkeys belong behind a clean plugin seam, which is exactly awthaq's plugin model.
- Server-side ceremony state should be an injected awthaq capability (`ChallengeStore`), so Redis/in-memory/cookie backends are swappable and TestClock-testable.

## Questions answered

### Q56 — Passkey/WebAuthn: RP config, multi-credential, challenge/replay, attestation defaults, platform quirks

#### Spec baseline (verified 2026-09)

- Web Authentication Level 3 reached **W3C Recommendation on 25 August 2026** (Candidate Recommendation snapshot 2026-05-26; proposed advancement 2026-07-20). [w3.org/TR/webauthn-3](https://www.w3.org/TR/webauthn-3/), [W3C news](https://www.w3.org/news/2026/proposed-advancement-of-webauthn-3-to-w3c-recommendation/), [publication history](https://www.w3.org/standards/history/webauthn-3/).
- FIDO Alliance published **"Server Requirements (WebAuthn Level 3 and CTAP2.3)"** (Review Draft, 2026-02-26) — the canonical checklist for server implementers: random challenges per ceremony, attestation validation incl. MDS, UP/UV flag validation, required COSE algorithms (RS256, ES256 required; ES384 recommended). [fidoalliance.org server spec](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)
- L3's headline features (excellent field summary: [Tim Cappalli, "WebAuthn L3"](https://blog.timcappalli.me/p/webauthn-3/)):
  - **BE/BS flags** in authenticator data — Backup Eligible (settable only at creation) and Backup State (can flip per ceremony).
  - **Conditional Get** (passkey autofill UI) and **Conditional Create** (automatic passkey upgrades).
  - **Signals API**: `signalUnknownCredential()`, `signalAllAcceptedCredentials()`, `signalCurrentUserDetails()` — fire-and-forget state push from RP to credential managers.
  - **JSON (de)serialization**: `PublicKeyCredential.parseCreationOptionsFromJSON()`, `parseRequestOptionsFromJSON()`, `credential.toJSON()` — no more hand-rolled base64url plumbing.
  - **`getClientCapabilities()`** replacing piecemeal feature-detection statics (`conditionalGet`, `conditionalCreate`, `passkeyPlatformAuthenticator`, `hybridTransport`, …).
  - **AAGUID reported even with `attestation: "none"`** (previously zeroed), enabling credential-manager labeling.
  - **Hints** (`securityKey` / `localDevice` / `remoteDevice`) refining authenticator guidance, and **Related Origin Requests** for multi-domain deployments.
- Spec editorial note: **Matthew Miller (SimpleWebAuthn author) is a WebAuthn L3 editor** and co-editor of the FIDO server spec — the TypeScript library ecosystem is directly plugged into spec evolution. [spec metadata](https://www.w3.org/TR/webauthn-3/), [FIDO server spec editors](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)

#### RP configuration: rpID, origins, ports, subdomains

- **rpID** must be a *registrable domain suffix* of the origin's effective domain: `www.example.com` may use `www.example.com` or `example.com`, never `com`. **`origin`** is the full URL the ceremony runs on; `http://localhost` and `http://localhost:PORT` are valid for dev. Ports are part of the *origin* check but never part of rpID. [SimpleWebAuthn "Identifying your RP"](https://simplewebauthn.dev/docs/packages/server), [better-auth passkey options](https://better-auth.com/docs/plugins/passkey)
- Awthaq config shape: `rpID`, `rpName`, `origins` (array — SimpleWebAuthn accepts an array of expected origins/RPIDs; support multiple deployment origins out of the box), optional `relatedOrigins` for ROR deployments.
- **Related Origin Requests** (L3): RP publishes `/.well-known/webauthn` listing additional origins usable with the same rpID — for ccTLD/multi-brand deployments. Same-party federation (OIDC redirect) remains the recommended alternative where possible. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/), [Corbado ROR guide](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys)
- **Quirk (CVE-grade):** origin comparison must be exact. CVE-2026-30964: web-auth/webauthn-lib < 5.2.4 reduced configured origins to host-only matching, silently accepting wrong scheme/port (`http://example.com`, `:8443`). [SentinelOne CVE analysis](https://www.sentinelone.com/vulnerability-database/cve-2026-30964/), [GHSA-f7pm-6hr8-7ggm](https://github.com/web-auth/webauthn-framework/security/advisories/GHSA-f7pm-6hr8-7ggm). Awthaq's verifier must compare `(scheme, host, port)` tuples and derive default port explicitly.

#### Ceremonies: registration & authentication

Registration: server generates options (rp{ id, name }, user{ id, name, displayName }, challenge, pubKeyCredParams, timeout, excludeCredentials, authenticatorSelection, attestation, extensions) → browser `navigator.credentials.create()` → server verifies challenge/origin/rpID, parses attestation, checks UP/UV flags, extracts credential public key + id + AAGUID + BE/BS → persists. Authentication: server generates options (challenge, rpId, allowCredentials, userVerification) → `navigator.credentials.get()` → server verifies challenge/origin/rpID, assertion signature against stored public key, signature counter, and maps `userHandle` → user → session. [SimpleWebAuthn server docs](https://simplewebauthn.dev/docs/packages/server), [FIDO server spec §2–3](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)

**User handle privacy**: generate a random per-user `webauthnUserID` used as the WebAuthn `user.id`, rather than exposing the internal user id to authenticators; a UNIQUE constraint on `(webauthnUserID, user)` maximizes privacy. [SimpleWebAuthn schema guidance](https://simplewebauthn.dev/docs/packages/server)

#### Passkey sync and BE/BS

- **BE (Backup Eligibility)**: whether the credential *may* be backed up — device-bound (security keys, `singleDevice`) vs synced (`multiDevice`). Set only at creation. **BS (Backup State)**: whether it *currently is* backed up; can change per authentication (e.g. credential-manager pending-deletion flips BS to 0). [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)
- Caveat: "Most Credential Managers always set synced passkeys to BS=1" — treat BS as advisory telemetry, not policy input, for now. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)
- Sync ecosystems: **iCloud Keychain** (Apple: iOS 16+/macOS 13+ for passkey support) and **Google Password Manager** (Android 9+); Samsung devices default to Samsung Pass, which fragments Android behavior (confirmed as a live operational problem by PhonePe at FIDO India 2026). [SimpleWebAuthn passkeys prerequisites](https://simplewebauthn.dev/docs/advanced/passkeys), [Corbado Conditional Create](https://www.corbado.com/blog/conditional-create-passkeys)
- Store per credential: `deviceType` (`'singleDevice' | 'multiDevice'`) and `backedUp` (bool); update `backedUp` from each authentication's BS flag — cheap analytics that tell you when users are at risk of lockout. [SimpleWebAuthn server docs](https://simplewebauthn.dev/docs/packages/server)

#### Multi-credential per user + credential management

- One row per credential in a dedicated table FK'd to the user; fields per SimpleWebAuthn's recommended schema: `id` (base64url, indexed), `publicKey` (raw bytes), `webauthnUserID`, `counter` (BIGINT — some authenticators emit atomic timestamps), `deviceType`, `backedUp`, `transports` (CSV/JSON array). [SimpleWebAuthn schema](https://simplewebauthn.dev/docs/packages/server)
- Registration passes `excludeCredentials` (existing credential IDs + transports) to prevent duplicate registrations; authentication passes `allowCredentials` when the user is known, `[]` for usernameless. [SimpleWebAuthn server docs](https://simplewebauthn.dev/docs/packages/server)
- Management surface (benchmark: better-auth plugin): list, rename, delete; AAGUID → friendly name resolution at read time from the community list [passkeydeveloper/passkey-authenticator-aaguids](https://github.com/passkeydeveloper/passkey-authenticator-aaguids) (better-auth ships a small best-effort map and documents the same resolution pattern). [better-auth passkey docs](https://better-auth.com/docs/plugins/passkey)
- **Deletion hygiene**: when an RP-side passkey is deleted, credential managers still offer it. L3's `signalUnknownCredential()` (pre-auth, on unknown-credential failures) and `signalAllAcceptedCredentials()` (in-session, after delete) close the loop; `signalCurrentUserDetails()` keeps display names fresh. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)

#### Challenge storage & replay prevention

- Spec: challenges "MUST contain enough entropy to make guessing them infeasible… SHOULD therefore be at least 16 bytes long"; FIDO server spec: CSPRNG per ceremony, "monotonically increasing challenges… unacceptable". [WebAuthn L3 §13.4.3](https://www.w3.org/TR/webauthn-3/), [FIDO server spec §2/§3](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)
- **Server-side store** (SimpleWebAuthn's recommended pattern): issue an anonymous session cookie (random ID) on login-page load; store `challenge` in Redis `SETEX` keyed by session ID with ~5-minute TTL; on verify, look up by cookie, pass as `expectedChallenge`, and **delete unconditionally — even on failed verification — to prevent replay**. [SimpleWebAuthn "Remembering challenges"](https://simplewebauthn.dev/docs/advanced/passkeys)
- **Cookie-bound challenge** (stateless alternative, used by better-auth): challenge persisted in a dedicated cookie (`webAuthnChallengeCookie`, default `better-auth-passkey`) and compared at verify time; good for edge/serverless where shared stores are unwanted; native-shell clients need cookie-prefix coordination (better-auth documents this for Expo). [better-auth passkey options](https://better-auth.com/docs/plugins/passkey)
- Both approaches must bind the challenge to: one ceremony, one type (registration vs authentication), a TTL (~2–5 min), and — for conditional create — tightly to the authenticated session. Counter checks (stored counter > 0 and returned ≤ stored) flag cloned authenticators, except that some platform authenticators (macOS Touch ID) always return 0. [SimpleWebAuthn counter note](https://simplewebauthn.dev/docs/packages/server)

#### Attestation conveyance defaults & FIDO MDS

- **Default `attestation: "none"`** — consumer passkeys are unattested; SimpleWebAuthn and better-auth both default/Recommend this. Requesting `direct` from synced passkeys is pointless (no meaningful attestation exists) and harms UX. [SimpleWebAuthn server docs](https://simplewebauthn.dev/docs/packages/server), [better-auth passkey docs](https://better-auth.com/docs/plugins/passkey)
- L3 change: **AAGUID is no longer zeroed under `none`** — RPs can label credentials by credential-manager without attestation. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)
- **`enterprise` attestation**: device-managed (MDM policy) attestation conveying uniquely-identifying info; only meaningful in workforce deployments with an authorized device estate. Keep as an opt-in plugin config, not a default. [WebAuthn L3 enterprise attestation](https://www.w3.org/TR/webauthn-3/#sctn-enterprise-attestation)
- **FIDO MDS (MDS3)**: signed metadata blob mapping AAGUID → metadata statement (attestation trust anchors, security characteristics); the FIDO server spec makes MDS-based validation a MUST for attestations. For a consumer-focused v1 with `none` attestation, MDS is *not needed*; expose it later as an optional enterprise module. [FIDO MDS overview](https://fidoalliance.org/metadata/), [FIDO server spec §2.1](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)

#### Usernameless / discoverable-credential flows

- Usernameless sign-in = `allowCredentials: []` + discoverable credentials (`residentKey: required|preferred`): the authenticator presents the account; the assertion's `userHandle` maps to the user server-side. SimpleWebAuthn: set `residentKey: 'required'`, `userVerification: 'preferred'` at registration, and enforce UV policy at *verification* time. [SimpleWebAuthn passkeys guide](https://simplewebauthn.dev/docs/advanced/passkeys)
- Passkey-first onboarding (register before any session) needs an out-of-band user resolution — better-auth's 1.6 passkey plugin added `registration.requireSession: false` + `resolveUser({ context })` + `createSession` on success. Awthaq should support this via its verification-token infrastructure. [better-auth 1.6 blog](https://better-auth.com/blog/1-6), [better-auth passkey docs](https://better-auth.com/docs/plugins/passkey)

#### Conditional UI / autofill

- Mechanics: call WebAuthn on page load with `mediation: 'conditional'`; add `autocomplete="username webauthn"` to the login input; abort the ceremony when the classic form submits; feature-detect via `getClientCapabilities().conditionalGet`. Nothing is disclosed to the RP unless the user picks a credential. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/), [Corbado conditional UI](https://www.corbado.com/blog/user-transition-passkeys-conditional-ui)
- **Do not ship conditional UI exclusively** — keep a "sign in with a passkey" button as well; autofill prompts can require field focus and don't fire for all users. [Corbado conditional UI](https://www.corbado.com/blog/user-transition-passkeys-conditional-ui)
- **Conditional Create (auto passkey upgrades)**: opportunistic creation in the credential manager that just autofilled the password. Support: Safari 18+ (iOS/macOS), Chrome 136+ (desktop), Chrome 142+ / Credential Manager 1.6+ (Android). **Chrome's registrations may carry UP=0/UV=0 — servers must accept this for the conditional-create path only** (tightly session-bound dedicated endpoint). Chrome enforces a ~5-minute window after the password login; late calls fail silently. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/), [Corbado Conditional Create](https://www.corbado.com/blog/conditional-create-passkeys)
- Effectiveness (Corbado 2026 benchmark): conditional-create-only plateaus ≈20% passkey adoption; adding basic manual enrollment prompts ≈40%; full best-practice rollout reaches 60–80% on mobile-heavy consumer apps. iOS autofill share (20–50%) sets the ceiling; Samsung Pass defaults suppress Android. [Corbado Conditional Create](https://www.corbado.com/blog/conditional-create-passkeys), [Passkey Benchmark 2026](https://www.corbado.com/passkey-benchmark-2026)

#### Platform quirks & edge cases (checklist)

- **Apple reports all-zero AAGUID** under default `attestation: "none"` flows on some OS versions — never key UX off AAGUID alone; always fall back to a generic label. [better-auth passkey docs](https://better-auth.com/docs/plugins/passkey)
- **macOS Touch ID signature counter is always 0** — counter-cloning detection is impossible there; treat counter==0 as "no signal", never as failure. [SimpleWebAuthn counter note](https://simplewebauthn.dev/docs/packages/server)
- **Samsung Pass defaults** over Google Password Manager on Samsung Android — conditional create becomes effectively opt-in; Android CC rates lower than iOS even on capable devices. [Corbado Conditional Create](https://www.corbado.com/blog/conditional-create-passkeys)
- **Ports**: two origins differing only by port are different origins; a dev server on `:3000` needs `http://localhost:3000` in the allowed-origin set. The webauthn-lib CVE shows what happens when this is fuzzy. [CVE-2026-30964](https://www.sentinelone.com/vulnerability-database/cve-2026-30964/)
- **Native shells**: challenge cookies must survive WebView/native storage (Expo `cookiePrefix` coordination). [better-auth Expo note](https://better-auth.com/docs/plugins/passkey)
- **Counter regression ≠ instant kill**: log + step-up, don't hard-lock (platform bugs exist); only counter > 0 with equal/lower returned value is suspicious. [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server)
- **Stale credentials in managers**: unknown-credential sign-in failures should trigger `signalUnknownCredential()` + enumeration-safe messaging. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)

#### Known WebAuthn-ecosystem CVEs / pitfalls

- **CVE-2026-30964** — web-auth/webauthn-lib < 5.2.4: origin validation bypass via host-only matching (scheme/port ignored). Class: *origin comparison must be exact*. [SentinelOne](https://www.sentinelone.com/vulnerability-database/cve-2026-30964/), [GHSA-f7pm-6hr8-7ggm](https://github.com/web-auth/webauthn-framework/security/advisories/GHSA-f7pm-6hr8-7ggm)
- **CVE-2026-46419 / YSA-2026-02** — Yubico java-webauthn-server 2.8.0–2.8.1: user impersonation in the "second-factor" flow when target username has no user handle; attacker's own valid assertion gets attributed to the target username. Class: *the credential returned by the ceremony is the identity source of truth — never the lookup input*. Fix: 2.8.2/2.9.0. [Yubico advisory](https://www.yubico.com/support/security-advisories/ysa-2026-02/)
- **CVE-2026-47841** — Spring Security WebAuthn: user verification bypass when session state is externalized/deserialized. Class: *ceremony state must be bound to the exact session that started it*. [Spring advisory](https://spring.io/security/cve-2026-47841)
- Historical class note: JVM-side CVE-2022-21449 (psychic signature, ECDSA) invalidated attestation/assertion verification on affected JDKs — pin crypto libraries and test with known vectors. [Yubico java-webauthn-server notes](https://github.com/yubico/java-webauthn-server)
- Structural pitfall across all three 2026 CVEs: the library verified cryptography correctly; the *glue* (which user, which origin, which session) was wrong. Awthaq's design must make those bindings explicit and typed in one place.

#### Proposed awthaq passkey plugin shape

**Dependency decision**: wrap `@simplewebauthn/server` v14 (MIT; Node 22+/Deno 2.4+ via JSR; maintained, spec-aligned) for CBOR/COSE/attestation parsing and signature verification. Own implementation is unjustifiable risk: the CVE record above shows even dedicated library teams get glue-level checks wrong, and the CBOR/attestation-format matrix (packed/TPM/Android-Key/Apple/U2F/none) is pure undifferentiated heavy lifting. The Effect layer is where awthaq adds value. [SimpleWebAuthn docs](https://simplewebauthn.dev/docs/packages/server), [npm](https://www.npmjs.com/package/@simplewebauthn/server)

```ts
// @awthaq/plugin-passkey
import { passkey } from "@awthaq/passkey"

const AuthLayer = Auth.make({
  plugins: [password(), passkey({
    rpID: Config.string("AUTH_RP_ID"),
    rpName: Config.string("AUTH_RP_NAME").pipe(Config.withDefault("My App")),
    origins: Config.string("AUTH_ORIGINS").pipe(Config.split(",")), // exact scheme+host+port
    attestation: "none",                    // opt-in: "direct" | "enterprise"
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
    conditionalCreate: true,                // relaxed UP/UV on dedicated endpoint only
    challenge: { store: "redis", ttl: "5 minutes" } // or { store: "cookie" } for stateless
  })]
})
```

**Services** (Context.Tags; all injected, all mockable):

| Service | Role |
| --- | --- |
| `PasskeyOptions` | Builds registration/authentication option JSON (wraps SimpleWebAuthn `generateRegistrationOptions`/`generateAuthenticationOptions`); owns rpID/origin config. |
| `PasskeyVerifier` | Verifies responses (wraps `verifyRegistrationResponse`/`verifyAuthenticationResponse`); returns typed results incl. BE/BS, AAGUID, counter. |
| `ChallengeStore` | Capability: `issue(scope) → challenge`, `consume(scope, challenge) → boolean` (single-use, TTL via `Clock`/TestClock). Default impls: Redis (prod), memory (test), cookie (edge). |
| `PasskeyRepository` | Plugin schema repo: `findByCredentialId`, `listByUserId`, `create`, `updateCounter/backedUp`, `delete`. |
| `PasskeyClientSignals` | Best-effort `signalUnknownCredential`/`signalAllAcceptedCredentials`/`signalCurrentUserDetails` emitted as fire-and-forget Effects after delete/rename/failure. |

**Endpoints** (HttpApi group `passkey`, per PRD §route taxonomy `POST /auth/passkey/*`):

| Route | Purpose |
| --- | --- |
| `POST /auth/passkey/register/options` | Requires session (or verification token for passkey-first). Returns `PublicKeyCredentialCreationOptionsJSON`; issues challenge via `ChallengeStore`. |
| `POST /auth/passkey/register/verify` | Verifies response, persists credential (+BE/BS, AAGUID, transports), emits `PasskeyRegistered` event. |
| `POST /auth/passkey/register/options/conditional` | Dedicated conditional-create endpoint: session-bound, accepts UP=0/UV=0. |
| `POST /auth/passkey/authenticate/options` | `allowCredentials` by user, or `[]` for usernameless + conditional UI. |
| `POST /auth/passkey/authenticate/verify` | Verifies assertion, updates counter/BS, creates session via core session capability. |
| `GET /auth/passkey/credentials` | List current user's credentials (id, label, AAGUID-derived name, deviceType, backedUp, created/lastUsed). |
| `PATCH /auth/passkey/credentials/:id` | Rename. |
| `DELETE /auth/passkey/credentials/:id` | Delete + `signalAllAcceptedCredentials`; guard: cannot delete last credential without replacement (linkage with account-recovery policy). |

**Schema** (plugin side table, zero core coupling per PRD Q51):

```text
passkey
  id             TEXT PK            -- base64url credential ID
  user_id        TEXT NOT NULL FK → user.id ON DELETE CASCADE
  webauthn_user_id TEXT NOT NULL    -- random per-user handle; UNIQUE(user_id, webauthn_user_id)
  public_key     BLOB NOT NULL      -- raw COSE key bytes
  counter        BIGINT NOT NULL DEFAULT 0
  device_type    TEXT NOT NULL      -- 'singleDevice' | 'multiDevice'
  backed_up      BOOLEAN NOT NULL DEFAULT false
  transports     TEXT               -- CSV of transports
  aaguid         TEXT               -- for labeling
  name           TEXT               -- user-chosen label
  last_used_at   TIMESTAMP
  created_at     TIMESTAMP
```

**Typed errors** (HttpApi error union): `PasskeyChallengeInvalid` (missing/expired/replayed), `PasskeyOriginMismatch`, `PasskeyRpIdMismatch`, `PasskeyCredentialNotFound`, `PasskeyVerificationFailed`, `PasskeyUserVerificationRequired`, `PasskeyCounterAnomaly` (log+step-up), `PasskeyLastCredential` (delete guard).

**Client package**: `passkeyClient()` in `@awthaq/client` exposing `registerPasskey`, `authenticate({ autoFill })` (conditional UI via `startAuthentication({ useBrowserAutofill: true })`), `listPasskeys`, `renamePasskey`, `deletePasskey`, plus feature-detection helpers (`getClientCapabilities`). Mirrors better-auth's client-plugin ergonomics. [better-auth passkey docs](https://better-auth.com/docs/plugins/passkey), [SimpleWebAuthn browser docs](https://simplewebauthn.dev/docs/packages/browser)

**Sessions integration**: authentication-verify handler calls the core `SessionManager` capability to create the session — the plugin never sets cookies itself; passkey-first flows reuse the verification-token machinery (Q46) for the pre-auth grant.

**Evidence anchors**: PRD Milestone 4 deliverables (WebAuthn registration/authentication/credential management) map 1:1 onto this surface; `PasskeyRepository` and `PasskeyRegistered` event already exist as PRD concepts ([PRD.md §19.2, §events](../PRD.md)).

**Recommendation:** Ship `@awthaq/passkey` as a Phase-1 official plugin wrapping `@simplewebauthn/server` v14: default `attestation: "none"`, `residentKey/userVerification: preferred`, pluggable `ChallengeStore` (Redis default, cookie for edge, single-use + 5-min TTL, deleted on every verification attempt), exact `(scheme, host, port)` origin sets with array support, per-user random `webauthnUserID`, full credential CRUD + Signals API, conditional UI on by default and conditional create behind a dedicated session-bound endpoint that relaxes UP/UV. Defer attestation/MDS to an enterprise module.

**Confidence:** high

### Q63 (passkey-related portion) — Passkey UX best practice for awthaq

*(Captcha/bot-defense is out of scope for this file per assignment; this answer covers the passkey UX dimension of Q63 only.)*

**Evidence.** Corbado's 2026 benchmark (100+ interviews with teams running large B2C deployments, normalized across readiness × creation × usage) is the strongest public dataset on what actually moves passkey adoption:

- Adoption compounds: `readiness × creation × usage = adoption impact`; the operational north-star is the **passkey login rate** (share of daily logins completed with passkeys). [Passkey Benchmark 2026](https://www.corbado.com/passkey-benchmark-2026)
- Conditional Create alone plateaus ≈20% adoption; + basic manual prompts ≈40%; full best practice 60–80% (mobile-heavy consumer). iOS benefits most (iCloud Keychain dominance; 20–50% autofill ceiling); Samsung Pass defaults suppress Android. [Conditional Create research](https://www.corbado.com/blog/conditional-create-passkeys)
- Conditional UI (autofill) improves transition because it requires zero new UI and zero user knowledge of "having a passkey" — but must be paired with a button fallback. [Corbado conditional UI](https://www.corbado.com/blog/user-transition-passkeys-conditional-ui)
- Framing matters at the API level: awthaq should return *machine-readable* ceremony outcomes so app teams can instrument enrollment/auth funnels (enrollment offer rate, creation completion, auth success rate) — the KPIs the benchmark tracks. [Benchmark KPI sections](https://www.corbado.com/passkey-benchmark-2026)

**Recommended UX posture encoded in plugin defaults:**

1. **Login**: conditional UI always attempted on page load + "sign in with a passkey" button; username-first flow stays available (progressive enhancement, never a trap door).
2. **Enrollment**: prompt after successful password login (highest-intent moment); conditional create opportunistically in the same session (5-min window); exclude existing credentials; silent-failure semantics (catch `NotAllowedError`/`AbortError`/`InvalidStateError` without error UI).
3. **Management**: AAGUID-derived friendly labels with generic fallback; BS-flip detection to warn users before lockout; delete always followed by `signalAllAcceptedCredentials`.
4. **Recovery**: never make passkey the only factor at v1; pair with email verification/magic-link (SimpleWebAuthn's bootstrap guidance) — plugin docs must state this. [SimpleWebAuthn passkeys guide](https://simplewebauthn.dev/docs/advanced/passkeys)

**Recommendation:** Bake the above into plugin defaults and client helpers; expose typed events (`PasskeyRegistered`, `PasskeyAuthenticated`, `PasskeyBackupStateLost`) so adoption funnels are observable out of the box.

**Confidence:** high

## Technologies & libraries

| Name | What it is | License | Maturity | Relevance to awthaq |
| --- | --- | --- | --- | --- |
| [@simplewebauthn/server](https://www.npmjs.com/package/@simplewebauthn/server) v14.0.1 | TS server lib: options generation + response verification, all attestation formats | MIT | Very active (pushed 2026-09-05); author is WebAuthn L3 spec editor | **Chosen dependency** for the passkey plugin's crypto/verification core |
| [@simplewebauthn/browser](https://simplewebauthn.dev/docs/packages/browser) v14 | Browser helper: `startRegistration`/`startAuthentication`, autofill, conditional create, feature detection | MIT | Same project/pace | Dependency of `@awthaq/client` passkey client |
| [@better-auth/passkey](https://better-auth.com/docs/plugins/passkey) 1.7.x | better-auth passkey plugin (SimpleWebAuthn-powered): challenge cookie, passkey-first, conditional UI, AAGUID labels | MIT | Production; actively developed | Primary API-shape benchmark; challenge-cookie pattern reference |
| Auth.js `passkey` provider | Experimental WebAuthn provider (SimpleWebAuthn v9, `Authenticator` table) | MIT | **Experimental, deprecated direction** — Auth.js joined Better Auth | Cautionary reference: adapter-fragmentation made passkeys hard there |
| [Yubico java-webauthn-server](https://github.com/yubico/java-webauthn-server) | Java server lib by Yubico; excellent docs + CVE-2026-46419 case study | BSD-2 [INFERENCE from repo] | Very mature | Documentation + advisory practices to emulate |
| [web-auth/webauthn-lib](https://github.com/web-auth/webauthn-lib) (PHP) | Symfony WebAuthn framework | MIT | Mature | CVE-2026-30964 origin-matching case study |
| [go-webauthn/webauthn](https://pkg.go.dev/github.com/go-webauthn/webauthn/protocol) | Go server lib | BSD-2 [INFERENCE] | Mature | Cross-language reference for server semantics |
| [FIDO MDS (MDS3)](https://fidoalliance.org/metadata/) | Signed authenticator metadata blob + TOC for attestation validation | FIDO Alliance terms | Production | Optional enterprise attestation module, not v1 |
| [passkey-authenticator-aaguids](https://github.com/passkeydeveloper/passkey-authenticator-aaguids) | Community AAGUID → credential-manager name/icon list | Open | Community-maintained | Labeling passkeys in management UI |
| [webauthn.io](https://webauthn.io) / [passkeys.dev](https://passkeys.dev) | Reference implementations + test tools (incl. feature detection) | Open | Stable | Dev-experience testing targets for our plugin docs |
| Chrome DevTools virtual authenticator | Emulated authenticators for local testing | — | Shipped in Chrome | Recommended in plugin testing docs ([Chrome docs](https://developer.chrome.com/docs/devtools/webauthn)) |

## Books, papers, blogs, talks

- [WebAuthn Level 3 (W3C REC 2026-08-25)](https://www.w3.org/TR/webauthn-3/) — the normative source; L3 is the baseline for any new implementation.
- [Tim Cappalli — "Web Authentication API (WebAuthn) Level 3" (2026-08)](https://blog.timcappalli.me/p/webauthn-3/) — the best field guide to every L3 feature (BE/BS, signals, conditional get/create, JSON helpers, hints, ROR) written by a spec editor.
- [FIDO Alliance — Server Requirements (WebAuthn L3 & CTAP2.3), RD 2026-02-26](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html) — the server-implementer checklist awthaq's verifier must satisfy.
- [SimpleWebAuthn docs (v14)](https://simplewebauthn.dev/docs/packages/server) — de-facto TypeScript implementation guide; schema, challenge handling, passkey options.
- [Corbado — Passkey Benchmark 2026](https://www.corbado.com/passkey-benchmark-2026) and [Conditional Create research](https://www.corbado.com/blog/conditional-create-passkeys) — the empirical UX data (adoption plateaus, platform splits, Samsung problem).
- [Yubico WebAuthn Developer Guide — Best Practices](https://developers.yubico.com/WebAuthn/WebAuthn_Developer_Guide/Best_Practices.html) — recovery/multi-key/credential-management doctrine from the deepest FIDO shop.
- [Yubico YSA-2026-02](https://www.yubico.com/support/security-advisories/ysa-2026-02/), [CVE-2026-30964 analysis](https://www.sentinelone.com/vulnerability-database/cve-2026-30964/), [Spring CVE-2026-47841](https://spring.io/security/cve-2026-47841) — the 2026 CVE trilogy that defines the glue-check threat model.
- [FIDO Alliance MDS overview](https://fidoalliance.org/metadata/) — what attestation validation would entail if/when enterprise mode arrives.
- [Corbado — Related Origin Requests guide](https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys) — multi-domain passkeys, relevant to multi-tenant futures.
- [better-auth 1.6 release notes](https://better-auth.com/blog/1-6) — passkey-first registration pattern (`resolveUser`, `createSession`).

## People & projects to follow

- **Matthew Miller ([MasterKale](https://github.com/MasterKale))** — SimpleWebAuthn author, WebAuthn L3 spec editor, FIDO server spec co-editor — [SimpleWebAuthn](https://github.com/MasterKale/SimpleWebAuthn), [blog](https://blog.millerti.me/about/).
- **Tim Cappalli** — Microsoft Identity; WebAuthn L3 editor; the L3 field guide — [blog.timcappalli.me](https://blog.timcappalli.me/p/webauthn-3/).
- **Corbado Research (Vincent Delitz et al.)** — passkey UX/adoption empiricism — [passkey-benchmark-2026](https://www.corbado.com/passkey-benchmark-2026).
- **Yubico Developers** — server-lib reference implementations and security-advisory discipline — [developers.yubico.com](https://developers.yubico.com/WebAuthn/).
- **Emil Lundberg, Nina Satragno, Akshay Kumar** — WebAuthn L3 editors (Yubico/Google); spec evolution (L4) watchers — [spec editors](https://www.w3.org/TR/webauthn-3/).
- **better-auth team** — now stewards Auth.js too; passkey plugin is the closest TS ecosystem analog — [better-auth.com](https://better-auth.com/), [Auth.js joins Better Auth](https://better-auth.com/blog/authjs-joins-better-auth).
- **passkeys.dev / passkeydeveloper** — community tools, AAGUID lists, feature detection — [tools.passkeys.dev](https://tools.passkeys.dev/featuredetect).

## Recommended defaults for awthaq

1. **Spec target**: implement to WebAuthn L3 (REC 2026-08-25) semantics; use the FIDO Server Requirements v2.3 RD checklist as the verification test matrix. [W3C REC](https://www.w3.org/TR/webauthn-3/), [FIDO RD](https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html)
2. **Dependency**: wrap `@simplewebauthn/server` v14 behind `PasskeyOptions`/`PasskeyVerifier` Context.Tags; never import it in handlers directly, so it stays swappable. Consider `@simplewebauthn/browser` in the client package. [rationale](https://simplewebauthn.dev/docs/packages/server)
3. **RP config**: `rpID` (single), `rpName`, `origins: string[]` compared as exact `(scheme, host, port)` tuples; `http://localhost[:port]` allowed for dev only; document rpID = registrable-suffix rule; optional `relatedOrigins` passthrough for `/.well-known/webauthn`. [SimpleWebAuthn](https://simplewebauthn.dev/docs/packages/server), [CVE-2026-30964 lesson](https://www.sentinelone.com/vulnerability-database/cve-2026-30964/)
4. **Challenges**: ≥32 random bytes (exceed the spec's 16-byte floor), TTL 5 minutes, single-use, consumed (deleted) on every verification attempt regardless of outcome, bound to ceremony type + session/cookie; implemented as the `ChallengeStore` capability with Redis/memory/cookie impls and TestClock-driven expiry tests. [SimpleWebAuthn challenge guidance](https://simplewebauthn.dev/docs/advanced/passkeys)
5. **Selection defaults**: `residentKey: "preferred"`, `userVerification: "preferred"`, `attestation: "none"`; enforce UV at verification (`requireUserVerification`) per step-up policy, not at options time. [SimpleWebAuthn passkeys guide](https://simplewebauthn.dev/docs/advanced/passkeys)
6. **Credential storage**: dedicated `passkey` table per the schema above; per-user random `webauthnUserID`; persist id/publicKey/counter/deviceType/backedUp/transports/aaguid; BIGINT counter; update BS + counter on every successful authentication. [SimpleWebAuthn schema](https://simplewebauthn.dev/docs/packages/server)
7. **Multi-credential + management**: `excludeCredentials` on registration; list/rename/delete endpoints with AAGUID-based labels (community list bundled, generic fallback); block deleting the last credential unless a replacement factor exists. [better-auth](https://better-auth.com/docs/plugins/passkey)
8. **Conditional UI first**: client helper `authenticate({ autoFill: true })` + `autocomplete="username webauthn"` guidance in docs; keep the button flow; feature-detect with `getClientCapabilities()`. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)
9. **Conditional create**: dedicated `/register/options/conditional` endpoint, session-bound, UP=0/UV=0 accepted *only* there; trigger client-side immediately after password sign-in; silent failure semantics. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/), [Corbado](https://www.corbado.com/blog/conditional-create-passkeys)
10. **Signals API**: call `signalUnknownCredential` on unknown-credential authentication failures and `signalAllAcceptedCredentials` after delete; fire-and-forget, typed events emitted for observability. [Tim Cappalli L3](https://blog.timcappalli.me/p/webauthn-3/)
11. **Attestation/MDS**: none by default; `direct`/`enterprise` accepted as config but gated behind documented enterprise module (MDS3 validation, attestation CA trust anchors) — post-v1. [FIDO MDS](https://fidoalliance.org/metadata/)
12. **Identity binding**: the verified assertion's credential → user mapping is the *only* identity source; never trust pre-ceremony lookup inputs for attribution (YSA-2026-02 lesson); ceremony state keyed to the initiating session (Spring CVE lesson). [Yubico advisory](https://www.yubico.com/support/security-advisories/ysa-2026-02/)
13. **Testing**: Chrome DevTools virtual authenticator recipes in `@awthaq/test`; regression tests for replayed challenge, wrong origin, wrong rpID, UV-required-missing, counter anomaly, stale BS flip. [Chrome docs](https://developer.chrome.com/docs/devtools/webauthn)
14. **Events**: emit `PasskeyRegistered` / `PasskeyAuthenticated` / `PasskeyBackupStateLost` / `PasskeyDeleted` on the core event bus (PRD §events) for adoption funneling.

## Open questions for the user

1. **Challenge-store default**: Redis-backed server-side store (SimpleWebAuthn-recommended, needs shared infra) vs signed HttpOnly challenge cookie (stateless, edge-friendly, better-auth style)?
   - (a) Redis default, cookie opt-in
   - (b) Cookie default, Redis opt-in
   - (c) `ChallengeStore` capability with no default beyond memory/test, app chooses
2. **Conditional create at v1?** It needs a second, UP/UV-relaxed registration endpoint and careful session binding.
   - (a) Ship at v1 (default on) — biggest adoption lever per Corbado
   - (b) Ship at v1 (default off, docs show the funnel impact)
   - (c) Post-v1
3. **Usernameless sign-in posture**: pure discoverable-credential login (`allowCredentials: []`) changes session-attribution semantics and enumeration surface.
   - (a) Usernameless as default authenticate path
   - (b) Username-first default, usernameless opt-in per app
4. **Last-credential delete guard**: hard-block (no way out without support) vs require an active alternate session vs require email re-verification inline?
   - (a) Hard-block with recovery education
   - (b) Allow with inline email/OTP re-verification
   - (c) Leave policy to app via hook
5. **Enterprise attestation timing**: build the MDS3 module now (behind a flag) or explicitly defer to Phase 3 (PRD enterprise plugins)?
   - (a) Defer (aligns with PRD phasing)
   - (b) Flag-gated module in Phase 1 for workforce early adopters

## Sources

- https://www.w3.org/TR/webauthn-3/ (W3C Recommendation, 2026-08-25)
- https://www.w3.org/news/2026/proposed-advancement-of-webauthn-3-to-w3c-recommendation/
- https://www.w3.org/standards/history/webauthn-3/
- https://fidoalliance.org/specs/fidoserver/fido-server-v2.3-rd-20260226.html (Server Requirements, WebAuthn L3 & CTAP2.3, RD 2026-02-26)
- https://blog.timcappalli.me/p/webauthn-3/ (L3 feature guide, 2026-08-19)
- https://simplewebauthn.dev/docs/packages/server (v14.0.x)
- https://simplewebauthn.dev/docs/advanced/passkeys
- https://simplewebauthn.dev/docs/packages/browser
- https://github.com/MasterKale/SimpleWebAuthn/releases (v14.0.1 current)
- https://www.npmjs.com/package/@simplewebauthn/server
- https://better-auth.com/docs/plugins/passkey
- https://better-auth.com/blog/1-6
- https://better-auth.com/blog/authjs-joins-better-auth (referenced via authjs.dev banner)
- https://authjs.dev/getting-started/authentication/webauthn (experimental provider; Auth.js → Better Auth)
- https://github.com/nextauthjs/next-auth-webauthn
- https://www.yubico.com/support/security-advisories/ysa-2026-02/ (CVE-2026-46419)
- https://github.com/yubico/java-webauthn-server
- https://www.sentinelone.com/vulnerability-database/cve-2026-30964/ (web-auth/webauthn-lib origin bypass)
- https://github.com/web-auth/webauthn-framework/security/advisories/GHSA-f7pm-6hr8-7ggm
- https://spring.io/security/cve-2026-47841 (Spring Security WebAuthn UV bypass)
- https://fidoalliance.org/metadata/ (FIDO MDS)
- https://developers.yubico.com/WebAuthn/WebAuthn_Developer_Guide/Best_Practices.html
- https://www.corbado.com/passkey-benchmark-2026
- https://www.corbado.com/blog/conditional-create-passkeys
- https://www.corbado.com/blog/user-transition-passkeys-conditional-ui
- https://www.corbado.com/blog/webauthn-related-origins-cross-domain-passkeys
- https://developer.chrome.com/docs/devtools/webauthn (virtual authenticators)
- https://github.com/passkeydeveloper/passkey-authenticator-aaguids
- https://tools.passkeys.dev/featuredetect
