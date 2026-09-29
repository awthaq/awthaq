# Decision register

39 validated issues need a product/design call before implementation (recommended status `ready-for-human`). Each carries the options the validator found and a recommendation shaped by the standing preferences (type-system-first, flexibility over complexity, no API-stability arguments, no `as`). Answer by editing the issue file's Comments with `Decision (date): …` and flipping it to `ready-for-agent`.


## P01 — Session integrity & cookie/CSRF correctness

### AGA-004 — No cookie carries CHIPS Partitioned; embedded deployments cannot authenticate

medium · security · workstream `session-cookie-policy` · dossier: [AGA-004](slices/01-core-sessions-users.md)

- A) Keep BEH-EA-055 fixed (status quo): wontfix IC-007/EP-008/AGA-004; fix BO-005 only by adding a lifetime to the fixed set.
- B) Add a `SessionCookieConfig` Context.Reference whose default is exactly today's attribute set, with a typed, closed union of opt-in modes: `Host` (default, __Host-, SameSite=Strict), `HostEmbedded` (__Host-, SameSite=None, Partitioned — CHIPS keeps the __Host- prefix), `SecureDomain({ domain, sameSite })` (__Secure- prefix + Domain for multi-subdomain apps), plus `persistence: 'absolute' | 'browserSession'` for Max-Age. Illegal combinations (e.g. __Host- + Domain) are unrepresentable by construction.
- C) Free-form cookie options passthrough (Auth.js style).

**Recommendation:** B. It matches the 'flexibility over complexity' preference while keeping the secure default byte-identical and making insecure/illegal combos unrepresentable (types-first). Default persistence: 'absolute' (Max-Age = absoluteExpiresAt - now, recomputed on every rotation) for Auth.js/better-auth parity (BO-005); 'browserSession' stays available. SameSite=None modes must keep the CSRF double-submit middleware mandatory (document in BEH-EA-055/Csrf).

### BO-005 — Session cookie is a browser-session cookie while the server session lives 30d — browser close forces re-login

medium · dx · workstream `session-cookie-policy` · dossier: [BO-005](slices/01-core-sessions-users.md)

- A) Keep BEH-EA-055 fixed (status quo): wontfix IC-007/EP-008/AGA-004; fix BO-005 only by adding a lifetime to the fixed set.
- B) Add a `SessionCookieConfig` Context.Reference whose default is exactly today's attribute set, with a typed, closed union of opt-in modes: `Host` (default, __Host-, SameSite=Strict), `HostEmbedded` (__Host-, SameSite=None, Partitioned — CHIPS keeps the __Host- prefix), `SecureDomain({ domain, sameSite })` (__Secure- prefix + Domain for multi-subdomain apps), plus `persistence: 'absolute' | 'browserSession'` for Max-Age. Illegal combinations (e.g. __Host- + Domain) are unrepresentable by construction.
- C) Free-form cookie options passthrough (Auth.js style).

**Recommendation:** B. It matches the 'flexibility over complexity' preference while keeping the secure default byte-identical and making insecure/illegal combos unrepresentable (types-first). Default persistence: 'absolute' (Max-Age = absoluteExpiresAt - now, recomputed on every rotation) for Auth.js/better-auth parity (BO-005); 'browserSession' stays available. SameSite=None modes must keep the CSRF double-submit middleware mandatory (document in BEH-EA-055/Csrf).

### IC-007 — Fixed non-configurable __Host-/Strict cookie forecloses legitimate deployments

low · architecture · workstream `session-cookie-policy` · dossier: [IC-007](slices/01-core-sessions-users.md)

- A) Keep BEH-EA-055 fixed (status quo): wontfix IC-007/EP-008/AGA-004; fix BO-005 only by adding a lifetime to the fixed set.
- B) Add a `SessionCookieConfig` Context.Reference whose default is exactly today's attribute set, with a typed, closed union of opt-in modes: `Host` (default, __Host-, SameSite=Strict), `HostEmbedded` (__Host-, SameSite=None, Partitioned — CHIPS keeps the __Host- prefix), `SecureDomain({ domain, sameSite })` (__Secure- prefix + Domain for multi-subdomain apps), plus `persistence: 'absolute' | 'browserSession'` for Max-Age. Illegal combinations (e.g. __Host- + Domain) are unrepresentable by construction.
- C) Free-form cookie options passthrough (Auth.js style).

**Recommendation:** B. It matches the 'flexibility over complexity' preference while keeping the secure default byte-identical and making insecure/illegal combos unrepresentable (types-first). Default persistence: 'absolute' (Max-Age = absoluteExpiresAt - now, recomputed on every rotation) for Auth.js/better-auth parity (BO-005); 'browserSession' stays available. SameSite=None modes must keep the CSRF double-submit middleware mandatory (document in BEH-EA-055/Csrf).


## P02 — OAuth / OIDC flow hardening

### AP-005 — RFC 6749 4.1.2.1 authorization error responses are unparseable by the callback contract

medium · compliance · workstream `oauth-callback-error-contract` · dossier: [AP-005](slices/03-oauth-flow.md)

- A: any `error` param (after state+cookie validation and flow consumption) becomes the same field-less OAuthCallbackFailed (400). Strictly uniform (JR-003/OAP-003).
- B: a new typed `OAuthAuthorizationDenied { error: Literals(['access_denied','invalid_request','unauthorized_client','unsupported_response_type','invalid_scope','server_error','temporarily_unavailable']) }` (400), raised only after the state+cookie check passes. error_description and error_uri are never echoed (provider-controlled free text). An unknown error code maps to OAuthCallbackFailed.
- C: B, plus redirect to flow.callbackURL with `?error=<code>` instead of JSON.

**Recommendation:** B. The `error` code is already visible to the user in the redirect URL, so echoing the enumerated code after state validation reveals nothing to an attacker (they cannot forge a valid state+cookie pair for the victim). It lets apps render 'you cancelled' vs 'something went wrong', the most common non-attack callback outcome. Keep JSON, not a redirect (C), consistent with OAuthApi.ts's documented typed-error convention.

### IC-003 — Zero OAuth provider presets — every app hand-assembles issuer/endpoints/mapProfile

medium · dx · workstream `oauth-provider-presets` · dossier: [IC-003](slices/04-oauth-provider-jwt.md)

- A. Keep mechanism-only; publish a docs table of per-vendor config.
- B. Ship data presets in an `@awthaq/oauth/presets` subpath (same package, same version).
- C. Ship presets as a separate, independently-versioned package (`@awthaq/oauth-presets`).

**Recommendation:** B — highest product value for the smallest surface; exact-issuer discovery makes stale presets fail loudly, and a subpath keeps the core import graph unchanged. C only if vendor churn later demands a separate release cadence.

### NAM-004 — Provider discovery resolved once at boot and dies the process on failure

medium · correctness · workstream `oauth-outbound-resilience` · dossier: [NAM-004](slices/03-oauth-flow.md)

- A: keep fail-fast, but retry discovery with jittered backoff before dying (ERS-003). Minimal, spec-neutral.
- B: A plus an opt-in per-provider `discovery: 'lazy'` mode. The provider resolves on first use, answers 503 ProviderUnavailable until resolved, is refreshed on a TTL, and is permanently disabled with a logged defect if the fetched issuer mismatches (BEH-EA-127 still holds per provider).
- C: make all discovery lazy by default.

**Recommendation:** B. Default behavior stays fail-fast (with A's retries), so BEH-EA-127's boot guarantee is unchanged for everyone who does not opt in, and deployments that need Auth.js-style availability can opt in per provider. This is the richer option at a bounded cost. Also dedupe the second boot resolution in OAuthTokenAccess.layer by sharing one resolved-provider registry service (`OAuthProviders`) between OAuth.layer and OAuthTokenAccess.layer.

### NAM-006 — AccountExists always reports the conflicting provider as 'password'

low · correctness · workstream `oauth-account-linking-policy` · dossier: [NAM-006](slices/03-oauth-flow.md)

- A: drop the field (AccountExists becomes field-less, like the other uniform errors).
- B: `providers: ReadonlyArray<string>`, the real providerIds from `accounts.listByUser(existing.id)`, always populated.
- C: B, but populated only when the callback's own profile.emailVerified === true (the caller proved control of that mailbox at the provider). Otherwise an empty array.

**Recommendation:** C. BEH-EA-123's stated purpose for the typed error is to drive a 'sign in with X, then link' UI, which needs the real method list (a richer contract). Gating on the provider-verified email avoids handing a sign-in-method map to someone holding an unverified provider identity for the victim's address. Existence is already disclosed by BEH-EA-123 itself, so this adds only the method list. Update BEH-EA-123's sketch (`AccountExists { provider: "password" }`).


## P03 — JWT, signing keys & key rotation

### FAMS-005 — JWT plugin cannot interop with Firebase tokens in either direction

medium · api · workstream `jose-algorithm-coverage` · dossier: [FAMS-005](slices/04-oauth-provider-jwt.md)

- A. Verification-only interop: RS256 in the lite verifier + a documented app-level recipe (verify Firebase token → Sessions.issue). No new endpoint.
- B. Ship an inbound `POST /jwt/exchange` (RFC 8693-style) with a configurable trusted-issuer list.

**Recommendation:** A now — it unblocks dual-running with no new trust surface; revisit B only if a concrete migrator needs signInWithCustomToken parity (avoid speculative infra).

### PDR-003 — JWT plugin mirrors a bearer token onto every authenticated response via x-jwt-token with no opt-out

medium · security · workstream `jwt-response-mirroring-opt-in` · dossier: [PDR-003](slices/04-oauth-provider-jwt.md)

- A. Keep always-on mirroring (better-auth `set-auth-jwt` parity, today's behavior).
- B. Config knob `mirrorResponses: "off" | "bearer" | "always"`, default `"off"`.
- C. Same knob, default `"bearer"` (only clients that already hold a bearer credential receive the header; cookie sessions never leak a portable token).

**Recommendation:** B — the knob gives every deployment the richer choice (flexibility), and default-off removes the silent cookie→portable-bearer conversion four independent auditors flagged; apps wanting better-auth parity opt into "always" with one line.


## P04 — Authorization: organizations, roles, qadi

### FAMS-004 — No per-user custom-claims store; Firebase setCustomUserClaims has no qadi-routed equivalent

medium · architecture · workstream `user-claims-store` · dossier: [FAMS-004](slices/08-authz-org-roles-qadi.md)

- Document-only: roles → Roles.layerSql; other claims → application-owned AttributeResolver.
- Ship an opt-in UserClaims store + resolver in @awthaq/qadi (or core).

**Recommendation:** Ship the opt-in store (flexibility wins, it is additive and the registry from AAPS-002 keeps it conflict-checked); place it in @awthaq/core only if JWT claim minting must share it.

### MTI-007 — Roles plugin is global and tenant-blind while organization permissions are per-org — two uncomposed authority models

medium · architecture · workstream `authz-model-boundaries` · dossier: [MTI-007](slices/08-authz-org-roles-qadi.md)

- A: Document the split (global Roles = platform authority; org authority only via Organization relations), naming guard, ADR — no new mechanism.
- B: Add optional organization scope to Roles.assign and surface scoped roles as a Roles-contributed RelationshipResolver (role:<name> on the org resource) — duplicates organization roles.
- C: Upstream in ../qadi: give AttributeResolver.resolve an optional resourceId (scoped attributes) so tenant facts become one mechanism — breaking qadi API change (YL-002's option).

**Recommendation:** A now (cheap, removes the confusion the three findings describe); organization roles already provide per-tenant roles, so B is duplicate infrastructure. Revisit C in ../qadi only if a second plugin needs resource-scoped attributes.

### OHS-004 — Team membership carries no role; no per-team permission override exists

medium · architecture · workstream `org-team-hierarchy` · dossier: [OHS-004](slices/08-authz-org-roles-qadi.md)

- No team roles (org-level statements govern all teams; document).
- Team-membership role + team-scoped statements, org statements as inherited default, team role as additive refinement (down the subtree once OHS-001 lands).
- Model team authority purely as qadi relations (team-admin) and leave the plugin's own gating org-level.

**Recommendation:** Option 2 — it is the 'team lead' capability both OHS-004 and ticket 34 point at, reuses PermissionEngine/canGrant, and composes with the closure table; option 3 would re-create RZS-006's split-brain.

### YL-009 — Roles plugin exposes no management API surface for administration

info · dx · workstream `roles-audit-and-admin` · dossier: [YL-009](slices/08-authz-org-roles-qadi.md)

- Keep Roles library-only (roadmap M3 deferral; apps write their own endpoints).
- Opt-in RolesAdmin plugin in @awthaq/roles, Path-B guarded.
- Put setRole in @awthaq/admin (ticket 19 rejected this placement).

**Recommendation:** Option 2 — the durable store now exists (BAM-006), it respects ticket 19's placement ruling, and it gives the repo its first real RequirePermission consumer (YL-004).


## P05 — Admin & impersonation

### ALF-005 — Zero tamper-evidence on the one durable audit table — history is rewritable by anyone with SQL access

medium · security · workstream `admin-audit-integrity` · dossier: [ALF-005](slices/10-passkey-admin.md)

- A. In-DB hash chain: add `prevHash`/`rowHash` columns to admin_impersonation (and core audit_log), rowHash = HMAC(key, prevHash || canonical row); writes serialized per table (single-writer transaction / advisory lock); `verifyChain` Effect + scheduled job alerting on breaks; endEpisode appends a closing link instead of mutating hashed columns.
- B. External append-only sink: an `AuditExportSink` port (subscriber over AuthEvents/AuditLog) shipping rows to a write-once destination (S3 object-lock, SIEM) the app cannot rewrite.
- C. DB-level controls only: migrations add a Postgres trigger rejecting UPDATE of immutable columns and all DELETEs, plus documented REVOKE guidance; SQLite gets triggers too.
- D. Document as a deployment responsibility (won't fix in library).

**Recommendation:** C now + A for both admin_impersonation and core audit_log in one shared primitive (so the durable AuditLog from ticket 1 gets the same guarantee), and B as an optional port once a real consumer exists. C is cheap and blocks the casual rewrite; A makes forgery by a DBA detectable, which is the finding's actual threat model.

### APS-006 — Impersonation cookie overwrite strands the admin's own live session with no handback

medium · correctness · workstream `admin-impersonation-cookie-contract` · dossier: [APS-006](slices/10-passkey-admin.md)

- A. Distinct impersonation cookie: impersonate sets `__Host-impersonation` (same attributes) and leaves `__Host-session` untouched; `Api.Authentication`/`OptionalAuthentication` gain a first security entry `{ impersonation, cookie, bearer }` whose handler only accepts sessions carrying `actingAs`; stopImpersonating/forceStop-of-own-episode clears `__Host-impersonation` (Max-Age=0). The admin's own cookie is never destroyed, BEH-EA-216's no-handback semantics survive verbatim, and bearer clients are unaffected.
- B. Handback: record the admin's own session id on the episode row and have stopImpersonating re-issue a superseding admin session + Set-Cookie (contradicts BEH-EA-216 'MUST NOT issue any replacement session'; re-mints admin credentials from an impersonation session — weaker).
- C. Body-only delivery: impersonate returns the token in the body (no Set-Cookie) for the client to swap itself — impossible for httpOnly-cookie browser apps without JS token handling (security regression).
- D. Document-only: state that in cookie mode stopImpersonating == logout, and make the admin UI re-authenticate.

**Recommendation:** Option A. It is the only option that keeps BEH-EA-213's 'caller's session untouched' and BEH-EA-216's 'no handback' literally true for browser clients, costs one extra security-record entry (BEH-EA-071/072 already make the security record the whole strategy chain), and composes with ticket 17's opt-in bearer delivery for native clients. Ship it together with WPS-004's shared session-delivery helper so admin/passkey/password all deliver through one code path.

### AR-003 — Admin API shares the public surface — no separate tier, scheme, or network boundary

medium · architecture · workstream `admin-api-tier` · dossier: [AR-003](slices/10-passkey-admin.md)

- A. Contract-level tier: AuthPlugin contract groups may be tagged `tier: "admin"`; Auth.make exposes `api` (public) and `adminApi` separately, AuthHttp serves admin groups under a configurable prefix/port (default: same server, `/admin` prefix) so operators can firewall it; add an optional `AdminAuthentication` middleware slot (BEH-EA-071 already allows per-group schemes) that hosts can bind to mTLS/service principals, with canImpersonate as the in-handler backstop.
- B. Middleware-only: keep one HttpApi, add a pluggable `AdminAuthentication` middleware layered in front of Authentication on admin groups (no separate serving).
- C. Won't fix: document that admin endpoints share the public surface and that network isolation is the host's reverse-proxy job.

**Recommendation:** A (richest, and BEH-EA-071 already sanctions per-group schemes). The admin surface is about to grow ~14 endpoints (BAM-005/EP-003), which raises the value of being able to firewall it. Default behavior stays identical (same server, same auth) so no deployment is forced to split.


## P07 — Password, hashing, mail & verification tokens

### PHS-002 — needsRehash uses strict equality, enabling silent downgrade of stronger hashes

medium · security · workstream `password-hasher-verify-hardening` · dossier: [PHS-002](slices/09-ports-apikey-cli.md)

- A: keep equality (BEH-EA-116 as written); only fix the misleading header comment.
- B: switch to floor semantics unconditionally and amend BEH-EA-116.
- C: policy knob AUTH_PASSWORD_REHASH_POLICY=floor|exact, default floor; amend BEH-EA-116 (richer, keeps deliberate downgrade possible).

**Recommendation:** C — floor by default closes the silent-downgrade path, while 'exact' preserves the legitimate 'we over-tuned cost and must lower it' operation; both are one comparison each, so the richer option costs almost nothing.

### TMS-005 — signUp responds EmailAlreadyExists — account enumeration inconsistent with the plugin's own anti-enumeration posture

medium · security · workstream `password-policy-posture` · dossier: [TMS-005](slices/07-password-mfa.md)

- A: keep 409 EmailAlreadyExists; add ADR 017 recording it as the deliberate exception to BEH-EA-086 with signUp/signUpByIp rate limits as compensating controls.
- B: always conceal — signUp returns 202 'check your email' for both branches; existing address gets an 'you already have an account' mail; session only after verification.
- C: config `signUpEnumeration: "reveal" | "conceal"` (default reveal) implementing both A's documentation and B's flow.

**Recommendation:** C — flexibility over complexity: most apps want reveal UX, security-sensitive ones need conceal; the conceal branch reuses the mail dispatcher and Verification already present. Document the default in an ADR either way.

### PHS-006 — Breach screening fully implemented but disabled by default

low · security · workstream `password-policy-posture` · dossier: [PHS-006](slices/07-password-mfa.md)

- A: keep `breachCheck: false`; document the OWASP/NIST rationale and the one-line opt-in prominently (README quickstart + BEH-EA-119).
- B: default `breachCheck: true` (fail-open) with PHS-004's timeout, so screening is on unless declined; document how to disable for air-gapped deployments.
- C: default on only when `NODE_ENV=production`-style config says so — rejected: environment-dependent security defaults are surprising.

**Recommendation:** B — NIST SP 800-63B §3.1.1.2 makes screening against compromised-password lists a SHALL; k-anonymity leaks only a 5-char SHA-1 prefix; fail-open + timeout keeps availability. Richer secure default wins; opting out stays one line.


## P08 — Passkeys / WebAuthn

### HSK-002 — Attestation conveyance ("direct"/"enterprise") exists but attestation is never verified anywhere

medium · security · workstream `webauthn-attestation-policy` · dossier: [HSK-002](slices/09-ports-apikey-cli.md)

- A: documentation + startup warning only.
- B: surface fmt + optional trustedAaguids/rejectSelfAttestation policy + warning (no MDS).
- C: narrow AttestationConveyance to 'none' until an MDS3 enterprise module exists (breaking BEH-EA-135's opt-in).

**Recommendation:** B — it turns a cosmetic knob into an enforceable one for the hardware-key use case with no MDS dependency, keeps BEH-EA-135's opt-in, and the warning covers operators who set the knob without a policy.

### TC-004 — Signals API entirely absent; no browser-side passkey surface in any shipped package

medium · dx · workstream `passkey-browser-signals` · dossier: [TC-004](slices/13-repo-features-tooling.md)

- A: Ship allAcceptedCredentials (after delete + after each successful sign-in) and currentUserDetails only; never signalUnknownCredential.
- B: A + signalUnknownCredential only in authenticated contexts (e.g. re-auth of a signed-in user whose presented credential is not theirs), where no enumeration leak exists.
- C: A + signalUnknownCredential on any unauthenticated failure with an unknown credential id, relaxing BEH-EA-136's uniform response for that one case.

**Recommendation:** B — richer than A at small cost and still enumeration-safe; allAcceptedCredentials after every successful sign-in already prunes stale credentials for the common case, so C's leak buys little.


## P09 — Persistence: SQL dialects, repositories, replicas

### CSG-006 — Core PII columns are plaintext at rest with no documented encryption boundary

medium · compliance · workstream `sql-docs-operations` · dossier: [CSG-006](slices/05-sql.md)

- A — Documentation only: state the boundary and make full-disk/DB encryption a deployer requirement.
- B — A plus opt-in app-level encryption of non-lookup PII columns (sessions.ipAddress/userAgent, users.metadata) via the existing Encryption port, off by default.
- C — B plus deterministic/blind-index encryption of users.email, preserving lookups via an HMAC index column.

**Recommendation:** B. It is the richer, configurable option and costs little: the Encryption port, AAD scheme and (after SMS-002) the undecryptable-degrade policy already exist in AccountsRepositoryLive. Defer C, since it changes the email-uniqueness semantics that ESR-003 and DRS-005 are settling and has no current customer.


## P10 — Events, hooks & observability

### CWM-004 — No outbound webhook delivery — Clerk webhook consumers have only in-process PubSub to migrate onto

medium · architecture · workstream `auth-event-external-delivery` · dossier: [CWM-004](slices/02-core-events-hooks.md)

- A. Docs only: state the single-process assumption and the in-process subscription recipe; no transport.
- B. Outbox relay over auth_audit_log + app-provided EventTransport port (cross-process fan-out), no webhooks plugin yet.
- C. B plus a first-party opt-in @awthaq/webhooks plugin (signed, retried, dead-lettered) scheduled as an M7 Phase-2 plugin.

**Recommendation:** C, staged: ship A's docs immediately, B right after the event schema/envelope workstreams (it needs eventId + a codec), and the webhooks plugin as an M7 Phase-2 plugin. Tailing the durable audit table (not the lossy dropping PubSub) is what makes delivery reliable, and it reuses what ticket 01 already built.


## P11 — Compliance: erasure, export, retention, redaction

### CSG-001 — Erasure cascade covers only core tables; plugin-owned PII survives account deletion

high · compliance · workstream `gdpr-erasure-export` · dossier: [CSG-001](slices/06-server-api.md)

- (a) Pseudonymize: keep admin_impersonation and AuditLog rows for SOC2 retention, but replace the erased userId/email with an irreversible tombstone (e.g. HMAC(userId, per-deployment salt)) inside the same transaction. This meets GDPR Art. 17 and keeps the audit trail's shape.
- (b) Hard-delete the rows that name the user, which loses the audit trail.
- (c) Retain unchanged under a documented Art. 17(3)(b)/(e) legal-obligation exemption, configurable per deployment.

**Recommendation:** (a) pseudonymization by default, with (c) available as an explicit ErasureConfig opt-in (the richer, configurable option). The mechanical steps 1-5 do not depend on this decision and can start now.

### CSG-005 — No data-subject access or portability export path in the HTTP surface

medium · compliance · workstream `gdpr-erasure-export` · dossier: [CSG-005](slices/06-server-api.md)

- (a) Core-only export now (user, accounts, sessions); plugin sections later.
- (b) A `DataExport` aggregating registry (ADR-EA-012) that plugins contribute sections to, mirroring the erasure contract. Built-in core sections plus passkey/organization contributions.
- (c) Reuse Hooks (a new observe/veto point). This is a poor fit, because hooks cannot return data.

**Recommendation:** (b). It is the richer, configurable option and gives every current and future PII-holding plugin one obvious place to declare its data. Decision 30 explicitly left export undecided ('noted as a natural next step').

### ESA-005 — Event payloads embed PII (email, login identifier, free-text reason) with no redaction or retention design for a durable sink

medium · compliance · workstream `auth-event-pii-posture` · dossier: [ESA-005](slices/02-core-events-hooks.md)

- A. Identifiers-only payloads (drop invitation email; subscribers join via records) + pseudonymize audit rows on user erasure + document stream privilege.
- B. Keep contact fields but store an HMAC digest instead of the raw value (email → digest) in both bus and audit row; no erasure hook needed for those fields.
- C. Keep payloads as-is; rely on a retention sweep (ticket 30's Retention service extended to auth_audit_log) to age rows out.

**Recommendation:** A, plus C's retention sweep as an operator-configurable add-on (flexibility): identifiers-only is the standard event-sourcing answer and the erasure cascade already owns the records that hold the email; pseudonymizing audit rows keeps the forensic timeline (tag/time/order) intact under GDPR Art. 17. B loses utility for legitimate notification subscribers without buying much over A.


## P12 — Composition, API surface & error taxonomy

### MA-004 — Environmental failures (SqlError, SchemaError, PlatformError) are systematically routed to the defect channel

medium · architecture · workstream `core-error-taxonomy` · dossier: [MA-004](slices/01-core-sessions-users.md)

- A) Codify the de facto policy (NHS-002/EEM-003's d16134b already chose it at the HTTP edge): infrastructure failures are defects. Remove PlatformError from every core *Shape E channel (orDie at the layer seam, as layerSql already does for SqlError/SchemaError) and write an ADR saying so. Smallest change; callers lose the ability to retry/fallback.
- B) Typed infrastructure error: one core `StoreUnavailable` (Data.TaggedError carrying `cause` and `operation`) replaces PlatformError in every core Shape and absorbs SqlError/SchemaError-from-IO in layerSql; genuine invariant violations still die. Middleware maps StoreUnavailable to 503 (+ Retry-After) instead of dying to 500. Callers (SQLite busy, pool exhaustion) can retry with Schedule.
- C) Status quo, documented per-layer (not recommended: Shape E channels stay non-authoritative).

**Recommendation:** B — richer and closes both findings: EEM-006's complaint (PlatformError taxing every call site with a die mapping) disappears because PlatformError no longer appears in any public channel, and MA-004's complaint (environmental failures uncatchable) is fixed with one typed, retryable error. Record it in a new ADR (spec/decisions/017/018-infrastructure-error-policy.md) and roll out per service (Sessions first — hot path — then Users/Accounts/Verification/AuditLog), since it touches ~270 orDie/die sites.


## P13 — Frontend: Next.js, React, client

### BO-006 — No stateless edge/middleware verify: presence check is the only proxy-safe primitive, jwt plugin sits unwired

medium · architecture · workstream `next-edge-stateless-tier` · dossier: [BO-006](slices/11-frontend-next-react-client.md)

- A — Won't fix: keep presence-only proxy.ts + DB-verified getSession (spec-compliant today); document the gap.
- B — Bearer-only edge helper: verify an `Authorization: Bearer <jwt>` header with the lite verifier (useful for API routes, useless for browser page navigations that only carry cookies).
- C — Opt-in JWT session-mirror cookie (jwt plugin) + `@awthaq/next/edge` `verifySessionJwt` helper; bounded revocation lag, never the boundary.

**Recommendation:** C — the richer, configurable option: it is the only one that helps real browser navigations at the edge, reuses the already-built lite verifier and PostAuthResponseHook, stays default-off, and keeps BEH-EA-188's boundary rule. Requires restoring @awthaq/jwt's `./verify` export first.


## P14 — Identity model & user lifecycle

### SAM-004 — No home for auth.users metadata; plugin-contributed fields are spec-only

medium · api · workstream `users-profile-surface` · dossier: [SAM-004](slices/01-core-sessions-users.md)

- A) Implement BEH-EA-040/048 as specified: a plugin declares typed scalar `userFields` (Schema per field + `clientWritable: boolean`, default per BEH-EA-048) in AuthPlugin.Service options; its migration adds `${pluginId}_${field}` nullable columns to users; Users gains typed get/set for declared fields; Auth.make's type computes the composed field set (types-first).
- B) Typed JSON attributes: one `attributes` JSON column keyed by plugin id, each plugin supplying a Schema; validated on write, gated per field.
- C) Docs only: sanctioned pattern = plugin-owned prefixed side table keyed by userId (+ the existing opaque metadata for app data).

**Recommendation:** A — it is what the spec already prescribes (BEH-EA-040 scalar-only shared-table extension through a declared extension point; BEH-EA-048 write-gating) and gives type-level field inference, matching the type-system-first preference. Ship C's documentation immediately as an interim note; decompose A into (1) declaration + type computation, (2) migration lane, (3) Users read/write + gating, (4) client DTO inference.


## P15 — MFA, passwordless & authentication assurance

### HSK-005 — Passkey sign-in emits no assurance signal, so a qadi-level 'hardware key required' policy is unimplementable

medium · api · workstream `session-assurance` · dossier: [HSK-005](slices/10-passkey-admin.md)

- A. Session-level authentication record: Sessions.issue accepts `authentication: { methods: ReadonlyArray<string> (amr, RFC 8176 values: "hwk"/"swk"/"user"/"pwd"/"otp"/"fed"), userVerified: boolean, credential?: { provider: "passkey", deviceType, aaguid } }`, persisted on the session row, surfaced on SessionView/UserPrincipal and mapped into the qadi subject attributes by the SubjectResolver; `reauthenticate`/TwoFactor append methods.
- B. Event-only: include the assurance data in auth.user.signedIn and let hosts build their own store.
- C. Defer until TwoFactor (ticket 05) lands and design amr once for both.

**Recommendation:** A, designed now so TwoFactor (ticket 05) appends to the same `methods` list instead of inventing its own. It is the only option that lets a qadi policy require `amr contains hwk` / `credential.deviceType == singleDevice`; hosts that don't care pay nothing (field defaults).


## P16 — Native, bearer & machine identity

### MAPS-004 — Auth scheme chain is a closed two-key record - no seam for new credentials

medium · architecture · workstream `bearer-credential-extensibility` · dossier: [MAPS-004](slices/06-server-api.md)

- (a) A registry of bearer resolvers keyed by a claims() predicate (recommended).
- (b) Keep decision 33's single Context.Reference; later contributors must wrap the previous resolver by hand. This is fragile, and the last provider silently wins.
- (c) Add a third HttpApiSecurity scheme (e.g. an x-api-key header) to Api.Authentication. This requires editing the contract for every new credential type, and spec/models/07 hints at it.

**Recommendation:** (a). Decision 33 fixed the JWT case but did not address multiple bearer contributors, and decision 10 (api-key) needs a second one. A registry is the flexible option and uses an extension-point kind the repo already has (ADR-EA-012).

### OCM-005 — Rotation-with-grace-window and transport for client secrets are explicitly undecided

medium · compliance · workstream `m2m-client-secret-lifecycle` · dossier: [OCM-005](slices/12-spec.md)

- A: dual-validity rotation with configurable bounded grace window (default 24 h, max 30 d) + x-api-key transport only for API keys, Bearer reserved for JWT (recommended)
- B: dual-validity rotation + accept both x-api-key and Authorization: Bearer for API keys (prefix-sniffed)
- C: no grace window — rotation is revoke+create (hard cut), x-api-key only

**Recommendation:** A — richer rotation (configurable grace, bounded) while keeping one unambiguous transport per credential type; B's dual transport adds strategy ambiguity for little gain, C causes rotation outages.


## P18 — Multi-tenancy, residency & enterprise federation

### DRS-005 — Login-path lookups are global-semantics queries (lower(email), (providerId, subject, issuer)) that scatter under any sharding

medium · performance · workstream `tenancy-residency` · dossier: [DRS-005](slices/05-sql.md)

- A — Global identity directory: email and (providerId, subject, issuer) stay globally unique. Users/accounts are the unsharded directory tier, and tenant partitioning applies to sessions/verification/audit only.
- B — Tenant-scoped identity: unique indexes are prefixed with COALESCE(tenantId, ''), so the same email is a different user per tenant. Login lookups require TenantContext.
- C — Both, selectable per deployment via alternative migration sets.

**Recommendation:** A. Ticket 18 fixed tenant = Organization row, and the organization plugin's membership model already lets one global user belong to many orgs. Tenant-scoped identity (B) would contradict that by forcing duplicate user rows per org, and C doubles the migration surface for a scenario with no customer yet. Revisit B as an opt-in only when a residency customer needs per-tenant identity isolation.

### DRS-007 — Organization record has no region/homeRegion attribute — orgs cannot be pinned to a residency zone

medium · compliance · workstream `org-config-and-tenancy` · dossier: [DRS-007](slices/08-authz-org-roles-qadi.md)

- Defer until a residency ADR exists.
- Ship an optional, config-validated homeRegion column now (no routing logic in the library).

**Recommendation:** Ship the optional column now — it is cheap, additive, and gives ticket 18's tenant model its residency key; routing stays application-side.

### EP-006 — Organization configuration is deployment-wide; SaaS-facing defaults fail open and unbounded

medium · security · workstream `org-config-and-tenancy` · dossier: [EP-006](slices/08-authz-org-roles-qadi.md)

- Keep better-auth-parity defaults (create allowed, unlimited orgs per user) and only add per-org overrides.
- Finite default organizationLimit (e.g. 10), create still allowed by default, plus per-org overrides.
- Fail-closed: allowUserToCreateOrganization defaults to false and a finite organizationLimit.

**Recommendation:** Option 2: self-serve org creation is the plugin's primary use case, but an unbounded per-user tenant count is a denial-of-service default; ship limitsFor regardless (richer, low cost).

### EP-010 — Invitations accepted from unverified emails by default

low · security · workstream `org-config-and-tenancy` · dossier: [EP-010](slices/08-authz-org-roles-qadi.md)

- Keep false (better-auth parity).
- Flip to true (fail-closed), opt-out via config.

**Recommendation:** Flip to true: membership confers tenant data access, and the flag already exists — this is a one-line secure default.


## P20 — Test suite, tooling & CI

### AVS-009 — No deprecation/breaking-change policy; versioning tooling wired but never exercised

medium · dx · workstream `ci-release-hardening` · dossier: [AVS-009](slices/13-repo-features-tooling.md)

- A: Pre-1.0 'breaking allowed in minors, always documented with changeset + migration note'; deprecation windows start at 1.0.
- B: Strict one-minor deprecation windows with runtime warnings starting now.
- C: Defer any policy until M8.

**Recommendation:** A. It follows the standing 'product value wins over API stability' preference for a pre-release library while still guaranteeing every break is communicated; B would slow the ongoing API consolidation (e.g. AVS-002's fold-in) for zero current consumers.

### MW-005 — Zero published artifacts: release pipeline designed and wired but never exercised

medium · dx · workstream `ci-release-hardening` · dossier: [MW-005](slices/13-repo-features-tooling.md)

- A: Publish a canary leaf (@awthaq/ports) now, as soon as a remote + npm org exist, to de-risk OIDC/provenance early.
- B: Keep everything private until M8 per roadmap; only do the agent-side prep (access, fixed group, dry-run script).
- C: Publish all packages at once under a 0.x `next` dist-tag.

**Recommendation:** A, with the agent-side prep (steps 1-3) done immediately regardless. Publishing a zero-dep leaf proves the pipeline without committing any plugin API; pre-release 0.x versioning means no stability promise is implied.

### MTS-011 — Generated quality dashboard is committed while its inputs are gitignored

low · dx · workstream `quality-metrics-regeneration` · dossier: [MTS-011](slices/13-repo-features-tooling.md)

- A: Untrack the HTML, keep JSON local-only, add a freshness guard to the renderer (cheap; keeps the tool available).
- B: Build a deterministic in-repo KPI extractor (TS-AST based: fileCount/LOC/`as` casts excluding `as const`/Brand.nominal/non-null `!`), commit the JSONs, and gate freshness in CI.
- C: Delete the dashboard toolchain entirely (script, package.json script, HTML).

**Recommendation:** A. Nothing in `pnpm check` consumes these KPIs, and the type-safety KPIs that matter (no `as`, no `!`) are better enforced as lint rules (see sibling AH-004 anders-hejlsberg / tooling-typecheck-lint) than as a dashboard. B is speculative infra with no consumer; revisit only if a gate wants KPI trends.

