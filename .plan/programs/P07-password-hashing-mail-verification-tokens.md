# P07 — Password, hashing, mail & verification tokens

Phase 2 · 37 open issues to fix (4 high, 20 medium, 12 low, 1 info) · 25 closed by validation · ~86h summed per-issue estimate (upper bound) · 3 need a decision first.

Each issue below links to its full dossier (evidence at HEAD `ec065a7`, fix steps, tests, acceptance) in its slice file. Work workstream by workstream, top to bottom; within a workstream do the canonical issue first — its fix closes the listed duplicates.

## `legacy-password-migration` — Legacy password verifiers for Firebase, better-auth, Supabase

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~17h · depends on workstreams: `password-hasher-verify-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [FAMS-001](../slices/09-ports-apikey-cli.md) | high | architecture | PARTIAL | L | — | Ship @awthaq/migrate-firebase with a firebase-scrypt LegacyPasswordVerifier (decision 21). |
| [SAM-001](../slices/09-ports-apikey-cli.md) | high | api | PARTIAL | S | — | Document and pin the Supabase/GoTrue bcrypt path on top of the existing verifier. |
| [BAM-004](../slices/09-ports-apikey-cli.md) | medium | dx | PARTIAL | M | — | Add a better-auth scrypt LegacyPasswordVerifier to @awthaq/migrate-better-auth. |

## `password-hasher-offload` — Bound and offload KDF work (decision 35)

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~13h · depends on workstreams: `password-hasher-verify-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ERS-001](../slices/09-ports-apikey-cli.md) | high | performance | CONFIRMED | L | — | Bound hashing concurrency on the WASM layers and add opt-in Node worker-pool PasswordHasher layers (decision 35). |
| [ERAS-004](../slices/09-ports-apikey-cli.md) | low | performance | CONFIRMED | S | ERS-001 | Document where password hashing should run. |

Closed by validation in this workstream: ACS-001 (DUPLICATE → ERS-001), ECF-004 (DUPLICATE → ERS-001), PHS-003 (DUPLICATE → ERS-001)

## `mailer-typed-delivery-errors` — Typed Mailer delivery failures

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EEM-002](../slices/09-ports-apikey-cli.md) | high | architecture | CONFIRMED | M | — | Give Mailer.send a typed MailDeliveryFailed error and make every caller choose a policy. |

Closed by validation in this workstream: SOS-002 (WONTFIX-CANDIDATE), SOS-003 (DUPLICATE → EEM-002)

## `password-hasher-verify-hardening` — Constant-time, clamped, non-downgrading, timing-uniform password verify

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~10h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PHS-001](../slices/09-ports-apikey-cli.md) | medium | security | CONFIRMED | M | — | Stop delegating argon2 comparison to hash-wasm: parse, recompute, compare in constant time. |
| [PHS-002](../slices/09-ports-apikey-cli.md) | medium | security | CONFIRMED ⚖️ decision | S | — | (Recommended option C) Add a rehash policy knob defaulting to floor semantics, amend BEH-EA-116, fix the header comment. |
| [ACS-006](../slices/09-ports-apikey-cli.md) | low | security | CONFIRMED | S | PHS-001 | Clamp stored-hash KDF parameters to configurable ceilings before any recomputation. |
| [TSS-006](../slices/09-ports-apikey-cli.md) | low | security | CONFIRMED | M | — | Add a calibrated minimum-duration floor to signIn's credential check and document the residual. |

Closed by validation in this workstream: PHS-007 (DUPLICATE → ACS-006)

## `password-policy-posture` — Password policy defaults and enumeration posture

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~7h · depends on workstreams: `mail-delivery-reliability`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [FAMS-003](../slices/07-password-mfa.md) | medium | correctness | CONFIRMED | S | — | Make the verified-email sign-in gate configurable (default unchanged) and document the migration step. |
| [PHS-004](../slices/07-password-mfa.md) | medium | security | PARTIAL | S | — | Treat an unparseable HIBP body and a slow provider as 'unavailable'. |
| [TMS-005](../slices/07-password-mfa.md) | medium | security | CONFIRMED ⚖️ decision | M | ERS-002 | Implement the chosen posture; at minimum record the exception in spec. |
| [PHS-006](../slices/07-password-mfa.md) | low | security | CONFIRMED ⚖️ decision | S | PHS-004 | After the decision: flip (B) or document (A). |

Closed by validation in this workstream: TSS-007 (DUPLICATE → TMS-005), RBS-005 (ALREADY-FIXED)

## `password-rate-limit-hardening` — Single-source, secret-free, normalized password rate-limit rules

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~8h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [CSD-006](../slices/07-password-mfa.md) | medium | architecture | CONFIRMED | S | — | Rewrite the RATE_LIMITS header comment. |
| [ESS-005-effect-schema-specialist](../slices/07-password-mfa.md) | medium | dx | CONFIRMED | S | — | Remove the three casts — delivered by RBS-006's single-source rule definitions (schema-decoded registry keys). |
| [MLO-003](../slices/07-password-mfa.md) | medium | security | PARTIAL | S | RBS-006 | Give resendVerification the same per-IP dimension. |
| [RBS-006](../slices/07-password-mfa.md) | medium | correctness | CONFIRMED | M | — | Make one typed rule definition feed both the registry and enforcement; key functions never see secrets. |
| [TMS-006](../slices/07-password-mfa.md) | medium | security | PARTIAL | S | RBS-006 | Normalize subaddressed emails for every per-email rate-limit key (delivery keeps the literal address). |

Closed by validation in this workstream: ARF-010 (ALREADY-FIXED), AGA-007 (ALREADY-FIXED), RBS-002 (ALREADY-FIXED), TMS-010 (ALREADY-FIXED)

## `mail-delivery-reliability` — Owned, observable, retrying mail dispatch; hardened Mailer contract

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~5h · depends on workstreams: `verification-token-delivery`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [EOTS-010](../slices/07-password-mfa.md) | medium | security | CONFIRMED | S | MLO-009 | Harden the Mailer contract: tokens as Redacted in data, never-log clause, no PII in layerNoop's defect. |
| [ERS-002](../slices/07-password-mfa.md) | medium | correctness | CONFIRMED | M | — | A layer-owned mail dispatcher: forks into a scoped FiberSet (still non-blocking), retries with jittered backoff, bounds concurrency, publishes `auth.mail.failed`, and drains on shutdown; Mailer.send gains a typed failure. |

Closed by validation in this workstream: MA-010 (DUPLICATE → ERS-002), MLO-007 (DUPLICATE → ERS-002), ARF-003 (ALREADY-FIXED)

## `verification-token-delivery` — Shared token codec + link data (opaque ids, expiresAt, urls)

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~5h · depends on workstreams: `password-recovery-correctness`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MLO-009](../slices/07-password-mfa.md) | medium | architecture | CONFIRMED | M | ARF-007 | Extract a shared, purpose-checked token codec + link builder into core and give every mailed token {url, token, expiresAt}. |
| [ARF-009](../slices/07-password-mfa.md) | low | security | CONFIRMED | S | MLO-009 | Replace the userId in token identifiers with a random public id; recover userId from the consumed VerificationTokenView. |

## `password-recovery-correctness` — confirmReset/requestReset correctness

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~4h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ARF-002](../slices/07-password-mfa.md) | medium | correctness | PARTIAL | S | — | Evaluate the password policy before opening the transaction / consuming the token. |
| [ARF-004](../slices/07-password-mfa.md) | medium | correctness | CONFIRMED | S | — | Skip reset issuance for credential-less accounts (inside the forked fiber, preserving uniform latency) and map the missing-credential case to TokenConsumed defensively. |
| [ARF-007](../slices/07-password-mfa.md) | low | correctness | CONFIRMED | S | — | Validate the purpose prefix right after decode in confirmReset and verifyEmail. |
| [ARF-008](../slices/07-password-mfa.md) | low | dx | CONFIRMED | S | — | Treat a consumed reset token as email verification. |

Closed by validation in this workstream: APS-004 (DUPLICATE → ARF-002), TMS-008 (ALREADY-FIXED), APS-005 (ALREADY-FIXED), CSD-008 (ALREADY-FIXED)

## `password-api-contract-hygiene` — Password contract hygiene (routes, sub-groups, schemas)

Slices: [07-password-mfa](../slices/07-password-mfa.md) · ~3h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [AVS-004](../slices/07-password-mfa.md) | medium | api | CONFIRMED | S | — | Make route ownership a composition-time check instead of a registry of exceptions. |
| [ESS-006-effect-schema-specialist](../slices/07-password-mfa.md) | medium | api | CONFIRMED | S | — | A shared `Email` schema at the contract boundary (+ a password length ceiling); runtime-config policy stays in checkPolicy. |
| [EHA-007](../slices/07-password-mfa.md) | low | api | CONFIRMED | S | — | Split authenticated password endpoints into a `password.account` sub-group. |

Closed by validation in this workstream: CDS-003 (ALREADY-FIXED), AR-002 (WONTFIX-CANDIDATE)

## `verification-store-hygiene` — Verification store: live-row lookup and payload parity

Slices: [05-sql](../slices/05-sql.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [PPS-003](../slices/05-sql.md) | medium | performance | CONFIRMED | S | — | Scope `findByIdentifier` to the live row so the existing partial unique index serves it with at most one row and no sort. History growth is handled by CSG-003's retention sweep (ticket 30), not a new index. |
| [ESS-010](../slices/05-sql.md) | low | correctness | CONFIRMED | S | — | Make the divergence unreachable: layerMemory normalizes explicit `null` to `undefined` at issue, matching the SQL encoding. Enforce it with a shared two-layer contract test. |

Closed by validation in this workstream: SSMS-003 (DUPLICATE → PPS-003), ESR-005 (DUPLICATE → PPS-003)

## `password-hasher-legacy-recipes` — ADR-010 correction + Supabase bcrypt recipe

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [SAM-002](../slices/12-spec.md) | medium | dx | PARTIAL | S | — | Correct ADR-010's example to the shipped LegacyPasswordVerifiers mechanism and publish a GoTrue/Supabase migration recipe that reuses the bcrypt verifier. |

## `verification-hardening` — Verification constant-time compare and race test

Slices: [01-core-sessions-users](../slices/01-core-sessions-users.md) · ~2h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [ACS-002](../slices/01-core-sessions-users.md) | low | security | CONFIRMED | S | — | Extract one shared constant-time comparator into @awthaq/ports and use it in Verification.layerMemory; document the SQL WHERE-equality exception. |
| [MLO-006](../slices/01-core-sessions-users.md) | low | testing | CONFIRMED | S | — | Add a concurrent-consume race test to the dual-layer Verification suite. |

Closed by validation in this workstream: MLO-004 (DUPLICATE → ACS-002), TSS-005 (DUPLICATE → ACS-002)

## `phc-hash-branding` — PhcHash brand

Slices: [09-ports-apikey-cli](../slices/09-ports-apikey-cli.md) · ~4h · depends on workstreams: `legacy-password-migration`, `password-hasher-offload`, `password-hasher-verify-hardening`

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [TTE-005](../slices/09-ports-apikey-cli.md) | low | api | CONFIRMED | M | PHS-001, ERS-001 | Introduce a PhcHash brand and thread it through the hasher port and credential storage. |

## `verification-timing-uniformity` — BEH-EA-064 latency-uniformity clause

Slices: [12-spec](../slices/12-spec.md) · ~1h

| Issue | Level | Cat | Verdict | Effort | Blocked by | Fix summary |
|---|---|---|---|---|---|---|
| [MLO-008](../slices/12-spec.md) | info | docs | CONFIRMED | S | — | Extend BEH-EA-064 so latency uniformity is normative (mail dispatch asynchronous to the response; equal work in both branches), matching what bd1625c implemented. |

