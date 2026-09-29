# Workstreams — merged across slices

Ranked by highest open severity, then security weight, then size. Effort is the sum of per-issue estimates (S=1h, M=4h, L=12h, XL=32h) for CONFIRMED/PARTIAL issues and is an upper bound — grouped fixes overlap.

| # | Workstream | Slices | Open (C/P) | Top level | Security | Est. hours | Depends on | IDs |
|---|---|---|---|---|---|---|---|---|
| 1 | `oauth-oidc-claims-integrity` | 03-oauth-flow | 8 | high | 2 | 11 | oauth-provider-response-decoding | OIT-001, AOMS-004, AP-003, AP-004, MA-002, OIT-003, OIT-004, APS-008, JJS-006, JR-008, OAP-006, OIT-006, OIT-008, OIT-009, SFS-005, VB-006, OIT-007 |
| 2 | `qadi-decision-cache-invalidation` | 08-authz-org-roles-qadi, 12-spec, 13-repo-features-tooling | 5 | high | 2 | 17 | PCS-001/RZS-002 implementation (cross-slice), org-qadi-relationships | PCS-001, PCS-002, RZS-002, AAPS-005, PCS-004, PCS-005, YL-007, RZS-008 |
| 3 | `keyprovider-rotation` | 09-ports-apikey-cli | 4 | high | 2 | 15 | — | KRS-002, ACS-009, AR-007, SMS-005-secrets-management-specialist, ACS-008 |
| 4 | `admin-impersonation-gate-target` | 10-passkey-admin | 3 | high | 2 | 9 | — | IDS-001, MTI-006, IDS-002, IDS-003, APS-009 |
| 5 | `mfa-two-factor` | 07-password-mfa | 3 | high | 2 | 45 | mail-delivery-reliability, password-rate-limit-hardening, password-recovery-correctness, session-issuance-context, verification-token-delivery | AOMS-003, ARF-005, THS-001, CSD-005, ACS-010, BCR-001, ECF-009, TTE-008 |
| 6 | `org-role-escalation-guards` | 08-authz-org-roles-qadi | 3 | high | 2 | 6 | — | RRM-001, OHS-005, RRM-002, RRM-007 |
| 7 | `ratelimit-memory-eviction` | 09-ports-apikey-cli | 2 | high | 2 | 8 | — | RBS-003, ERS-004, TMS-004 |
| 8 | `org-qadi-relationships` | 08-authz-org-roles-qadi | 6 | high | 1 | 12 | — | RZS-001, PERS-005, RRC-003, RZS-004, RZS-005, RZS-006, OHS-009 |
| 9 | `frontend-docs-truthfulness` | 11-frontend-next-react-client | 5 | high | 1 | 8 | next-react-ssr-bridge, next-server-action-facade, react-client-atoms-factory, react-provider-subject-pipeline | DESS-001, DESS-007, MTS-008, NAM-012, CWM-008 |
| 10 | `tenancy-residency` | 05-sql | 4 | high | 1 | 35 | organization TenantResolver/middleware (organization slice) | DRS-001, DRS-005, SAM-006, CSG-009, SSMS-009 |
| 11 | `cli-contract` | 13-repo-features-tooling | 3 | high | 1 | 6 | — | ECS-002, CTA-003, ECS-003 |
| 12 | `oauth-provider-boot-validation` | 04-oauth-provider-jwt | 3 | high | 1 | 3 | — | ESS-002, AP-007, OAP-005, TTE-003, AH-003-anders-hejlsberg, JR-009 |
| 13 | `apikey-machine-identity` | 09-ports-apikey-cli | 2 | high | 1 | 24 | tsconfig-paths-drift | MAPS-003, OCM-002, SCP-002, AR-006, SMS-008-secrets-management-specialist, TRBS-009 |
| 14 | `cli-session-login-carveout` | 12-spec | 2 | high | 1 | 5 | — | CTA-002, DAG-003, CTA-004 |
| 15 | `authn-failure-observability` | 06-server-api | 1 | high | 1 | 1 | observability-substrate (MW-001, slice 02), per-request-session-cache | EOTS-003 |
| 16 | `jwt-lite-verifier-jwks-cache` | 04-oauth-provider-jwt | 1 | high | 1 | 4 | — | ECF-002, JJS-002, KRS-010 |
| 17 | `jwt-signing-key-at-rest-encryption` | 04-oauth-provider-jwt | 1 | high | 1 | 4 | — | KRS-001, SMS-001 |
| 18 | `authz-docs-truthfulness` | 08-authz-org-roles-qadi | 7 | high | 0 | 24 | — | DTWS-002, SAM-005, SAM-007, JH-009, OHS-010, PERS-009, RRM-009, RRM-012 |
| 19 | `enterprise-federation-saml-scim` | 12-spec | 5 | high | 0 | 73 | multi-tenant-composition | AOMS-009, CWM-002, SFS-003, SCP-009, SFS-001, SFS-006, SFS-007, SFS-008 |
| 20 | `observability-substrate` | 02-core-events-hooks, 06-server-api, 13-repo-features-tooling | 5 | high | 0 | 19 | — | EOTS-002, MW-001, EOTS-005, EOTS-006, MAPS-007, NHS-008 |
| 21 | `react-provider-subject-pipeline` | 11-frontend-next-react-client | 5 | high | 0 | 17 | — | EAR-001, EAR-002, RSC-002, EAR-003, EAR-004, RSC-004, EAR-006, EAR-005 |
| 22 | `next-getsession-hardening` | 11-frontend-next-react-client | 4 | high | 0 | 4 | — | RRS-002, ETVS-006, NSA-006, RSC-007 |
| 23 | `oauth-outbound-resilience` | 03-oauth-flow | 4 | high | 0 | 10 | oauth-provider-response-decoding | ECF-001, EEM-004, ERS-003, NAM-004 |
| 24 | `org-write-atomicity-and-uniqueness` | 08-authz-org-roles-qadi | 4 | high | 0 | 13 | — | MTI-004, OHS-002, OHS-003, MTI-003, OHS-006 |
| 25 | `spec-status-banner-sweep` | 12-spec | 4 | high | 0 | 7 | — | DTWS-001, IDS-009, AOMS-011, OCM-008 |
| 26 | `bdd-feature-wiring` | 13-repo-features-tooling | 3 | high | 0 | 40 | bdd-suite-docs | AH-003-aslak-hellesoy, ESS-008-effect-stream-specialist, OCM-004, THS-006, TS-005-torin-sandall, ETVS-008 |
| 27 | `cli-manifest-tooling` | 09-ports-apikey-cli | 3 | high | 0 | 37 | legacy-password-migration | BE-003, ECS-004, FAMS-010, MW-006, CTA-007, ELC-008, ERS-008, RRM-011 |
| 28 | `core-hook-point-coverage` | 02-core-events-hooks | 3 | high | 0 | 9 | hook-registry-per-composition | NAM-002, SCP-008, TS-007-torin-sandall |
| 29 | `gdpr-erasure-export` | 06-server-api | 3 | high | 0 | 25 | hook-registry-scoping (ELC-001, slice 02) | CSG-001, DRS-002, CSG-005, SEA-001, SSMS-002, TS-004-tim-smart, CSG-007, TRBS-008 |
| 30 | `legacy-password-migration` | 09-ports-apikey-cli | 3 | high | 0 | 17 | password-hasher-verify-hardening | FAMS-001, SAM-001, BAM-004 |
| 31 | `sql-dialect-neutral-models` | 05-sql | 3 | high | 0 | 14 | — | TS-001-tim-smart, ESR-007, ESR-009, PPS-007, SSMS-007 |
| 32 | `users-identity-model` | 01-core-sessions-users | 3 | high | 0 | 37 | — | FAMS-002, SCP-005, SOS-008 |
| 33 | `admin-surface-expansion` | 10-passkey-admin | 2 | high | 0 | 44 | admin-impersonation-gate-target | BAM-005, EP-003 |
| 34 | `auth-event-envelope` | 02-core-events-hooks | 2 | high | 0 | 8 | auth-event-schema, auth-events-subscription | ESA-002, ALF-006, EOTS-009 |
| 35 | `bearer-credential-extensibility` | 06-server-api | 2 | high | 0 | 16 | m2m-identity (MAPS-003, slice 09) for the api-key contributor, per-request-session-cache, session-rotation-delivery | MAPS-001, AGA-003, JR-004, MAPS-004, VB-008 |
| 36 | `cli-exit-code-and-arg-contract` | 12-spec | 2 | high | 0 | 5 | — | ECS-001, ECS-007 |
| 37 | `multi-tenant-composition` | 12-spec | 2 | high | 0 | 44 | — | EP-001, EP-007 |
| 38 | `native-session-bootstrap` | 03-oauth-flow | 2 | high | 0 | 16 | oauth-callback-http-hardening, oauth-oidc-claims-integrity | MNA-003, MNA-004 |
| 39 | `org-team-hierarchy` | 08-authz-org-roles-qadi | 2 | high | 0 | 44 | org-write-atomicity-and-uniqueness | OHS-001, OHS-004, RZS-003 |
| 40 | `password-hasher-offload` | 09-ports-apikey-cli | 2 | high | 0 | 13 | password-hasher-verify-hardening | ERS-001, ACS-001, ECF-004, PHS-003, ERAS-004 |
| 41 | `passwordless-magic-link-email-otp` | 07-password-mfa | 2 | high | 0 | 24 | mail-delivery-reliability, mfa-two-factor, password-rate-limit-hardening, verification-token-delivery | BAM-007, SOS-001, MLO-005, IC-009, FAMS-007, SAM-009 |
| 42 | `read-replica-routing` | 01-core-sessions-users, 05-sql | 2 | high | 0 | 36 | session-list-liveness-and-pagination | RRC-001, DRS-004, RRC-004, RRC-005, RRC-006, RRC-008, RRC-007 |
| 43 | `sql-encrypted-token-read-path` | 05-sql | 2 | high | 0 | 13 | encryption-key-rotation (ports slice, KRS-002) | SMS-002-secrets-management-specialist, ESR-004, KRS-003, SMS-007-secrets-management-specialist, TS-005-tim-smart |
| 44 | `user-identity-lifecycle` | 05-sql | 2 | high | 0 | 36 | admin banned gate (BAM-005, admin slice; co-design), sql-dialect-neutral-models | SAM-003, SCP-001 |
| 45 | `auth-operation-tracing` | 07-password-mfa | 1 | high | 0 | 4 | — | EOTS-001 |
| 46 | `cli-import-tooling` | 12-spec | 1 | high | 0 | 32 | cli-exit-code-and-arg-contract | BAM-001 |
| 47 | `cli-session-commands` | 09-ports-apikey-cli | 1 | high | 0 | 12 | apikey-machine-identity, cli-manifest-tooling | CTA-001, DAG-002, CTA-005 |
| 48 | `data-retention-sweep` | 01-core-sessions-users | 1 | high | 0 | 12 | session-supersede-atomicity | CSG-003, DRS-003, ECF-008, ESR-006, TRBS-006, ERS-007 |
| 49 | `httpapi-surface-consolidation` | 01-core-sessions-users, 06-server-api | 1 | high | 0 | 12 | — | MW-002, AVS-002, BE-006, EHA-004 |
| 50 | `jwt-stateless-bearer-reentry` | 04-oauth-provider-jwt | 1 | high | 0 | 12 | jwt-claims-codec-hardening | NAM-001, IC-008 |
| 51 | `m2m-client-credentials` | 03-oauth-flow | 1 | high | 0 | 32 | shared-constant-time-compare | OCM-001 |
| 52 | `mailer-typed-delivery-errors` | 09-ports-apikey-cli | 1 | high | 0 | 4 | — | EEM-002, SOS-002, SOS-003 |
| 53 | `multi-tenant-oauth-connections` | 03-oauth-flow | 1 | high | 0 | 32 | oauth-outbound-resilience | CWM-001, EP-004 |
| 54 | `native-token-delivery` | 07-password-mfa | 1 | high | 0 | 4 | — | MNA-001 |
| 55 | `two-factor-recovery-codes` | 05-sql | 1 | high | 0 | 4 | two-factor plugin build (ticket 05: AOMS-003/THS-001/ARF-005) | BCR-002, BCR-009 |
| 56 | `oauth-callback-http-hardening` | 03-oauth-flow | 5 | medium | 4 | 8 | shared-constant-time-compare | CSS-004, PDR-004, RBS-008, TSS-003, CSS-006, OAP-008 |
| 57 | `password-hasher-verify-hardening` | 09-ports-apikey-cli | 4 | medium | 4 | 10 | — | PHS-001, PHS-002, ACS-006, PHS-007, TSS-006 |
| 58 | `mfa-two-factor-hardening` | 12-spec | 5 | medium | 3 | 8 | — | BCR-006, SOS-006, THS-004, BCR-010, THS-007 |
| 59 | `password-policy-posture` | 07-password-mfa | 4 | medium | 3 | 7 | mail-delivery-reliability | FAMS-003, PHS-004, RBS-005, TMS-005, PHS-006, TSS-007 |
| 60 | `org-tenant-read-isolation` | 08-authz-org-roles-qadi | 3 | medium | 3 | 17 | — | MTI-008, MTI-009, MTI-010 |
| 61 | `oauth-account-linking-policy` | 03-oauth-flow | 5 | medium | 2 | 5 | oauth-oidc-claims-integrity | AOMS-007, FAMS-006, NAM-005, TMS-007, EEM-007, NAM-006, BAM-011 |
| 62 | `passkey-ceremony-policy` | 10-passkey-admin | 5 | medium | 2 | 8 | passkey-challenge-store-hardening | BPAS-005, CB-003, MNA-007, TC-003, CB-009, HSK-007, TC-005 |
| 63 | `password-rate-limit-hardening` | 07-password-mfa | 5 | medium | 2 | 8 | — | CSD-006, ESS-005-effect-schema-specialist, MLO-003, RBS-002, RBS-006, TMS-006, AGA-007, ARF-010, TMS-010 |
| 64 | `org-config-and-tenancy` | 08-authz-org-roles-qadi | 4 | medium | 2 | 10 | — | AR-004, DRS-007, EP-005, EP-006, EP-010 |
| 65 | `session-docs-accuracy` | 01-core-sessions-users | 4 | medium | 2 | 4 | — | SEA-002, TRBS-005, PIL-006, APS-010 |
| 66 | `verification-otp-substrate` | 01-core-sessions-users | 4 | medium | 2 | 10 | — | BCR-005, MLO-002, SOS-004, THS-005, SOS-007, BCR-008 |
| 67 | `hmac-secret-hygiene` | 06-server-api | 3 | medium | 2 | 6 | — | SMS-004-secrets-management-specialist, ACS-005, ACS-007 |
| 68 | `ratelimit-signal-and-escalation` | 09-ports-apikey-cli | 3 | medium | 2 | 9 | ratelimit-distributed-store | EOTS-007, RBS-009, RBS-010 |
| 69 | `passkey-enumeration-safety` | 10-passkey-admin | 2 | medium | 2 | 5 | passkey-challenge-store-hardening | TC-001, TSS-004, CB-006, WPS-007 |
| 70 | `session-issuance-context` | 07-password-mfa | 2 | medium | 2 | 16 | — | CSD-003, SMS-004-session-management-specialist, APS-007 |
| 71 | `session-policy` | 01-core-sessions-users | 2 | medium | 2 | 16 | session-supersede-atomicity | SMS-003-session-management-specialist, THS-003, PIL-008 |
| 72 | `qadi-bridge-hardening` | 08-authz-org-roles-qadi | 8 | medium | 1 | 28 | — | AAPS-004, EEM-005, TS-001-torin-sandall, TS-002, TS-003-torin-sandall, YL-004, AAPS-008, YL-008 |
| 73 | `readme-docs-accuracy` | 13-repo-features-tooling | 8 | medium | 1 | 11 | examples-memory-server | DTWS-003, DTWS-004, CSS-005, CWM-007, DESS-008, IC-005, IC-010, NHS-009, SMS-006-secrets-management-specialist, SEA-007 |
| 74 | `jwt-claims-codec-hardening` | 04-oauth-provider-jwt | 5 | medium | 1 | 11 | — | GC-002, VB-005, JJS-007, JJS-008, JJS-009 |
| 75 | `auth-event-taxonomy` | 02-core-events-hooks | 4 | medium | 1 | 10 | auth-event-schema | ARF-006, CSD-004, SCP-006, RRS-008 |
| 76 | `core-error-taxonomy` | 01-core-sessions-users | 4 | medium | 1 | 38 | — | EEM-006, EOTS-004, ESS-008-effect-schema-specialist, GC-004, MA-004, EEM-008 |
| 77 | `next-server-action-facade` | 11-frontend-next-react-client | 4 | medium | 1 | 15 | client-promise-facade-errors, csrf-client-bootstrap, next-package-manifest-hygiene | BO-002, IC-004, NSA-003, ERS-006, NSA-008 |
| 78 | `passkey-challenge-store-hardening` | 10-passkey-admin | 4 | medium | 1 | 4 | — | WPS-003, WPS-005, BPAS-008, CB-007, WPS-008, WPS-009, HSK-010 |
| 79 | `session-rotation-delivery` | 06-server-api | 4 | medium | 1 | 10 | observability-substrate (MW-001, slice 02) for the redaction step only, per-request-session-cache, wire-constant-single-source | CTA-006, MNA-005, PIL-005, MAPS-008, NHS-007, PIL-009 |
| 80 | `session-cookie-policy` | 01-core-sessions-users | 3 | medium | 1 | 14 | — | AGA-004, BO-005, EP-008, IC-007 |
| 81 | `cli-doctor-hardening` | 12-spec | 2 | medium | 1 | 13 | cli-exit-code-and-arg-contract | ECS-005, ECS-008, EP-009 |
| 82 | `device-authorization-design` | 12-spec | 2 | medium | 1 | 2 | cli-session-login-carveout | DAG-004, DAG-007, DAG-006 |
| 83 | `hook-run-semantics` | 02-core-events-hooks | 2 | medium | 1 | 2 | hook-registry-per-composition | JH-002, JH-004, ECF-006, ERS-005, PERS-004, GC-009 |
| 84 | `mail-delivery-reliability` | 07-password-mfa | 2 | medium | 1 | 5 | verification-token-delivery | ARF-003, EOTS-010, ERS-002, MA-010, MLO-007 |
| 85 | `oauth-provider-response-decoding` | 03-oauth-flow | 2 | medium | 1 | 2 | — | ACS-004, AH-002, ESS-003-effect-schema-specialist, JJS-005, KRS-005, MA-006, OAP-004, OIT-005, VB-004, AOMS-010, AP-008, JR-010, OAP-007 |
| 86 | `passkey-counter-anomaly-policy` | 10-passkey-admin | 2 | medium | 1 | 8 | — | CB-004, HSK-004, WPS-006, BPAS-009 |
| 87 | `session-assurance-channel` | 08-authz-org-roles-qadi | 2 | medium | 1 | 16 | — | AAPS-006, SOS-005, AAPS-009 |
| 88 | `verification-token-delivery` | 07-password-mfa | 2 | medium | 1 | 5 | password-recovery-correctness | MLO-009, ARF-009 |
| 89 | `webauthn-attestation-policy` | 09-ports-apikey-cli | 2 | medium | 1 | 5 | — | HSK-002, TC-006, CB-008, HSK-006 |
| 90 | `admin-audit-integrity` | 10-passkey-admin | 1 | medium | 1 | 12 | admin-impersonation-lifecycle | ALF-005 |
| 91 | `jwt-response-mirroring-opt-in` | 04-oauth-provider-jwt | 1 | medium | 1 | 4 | — | MAPS-005, PDR-003, VB-009 |
| 92 | `jwt-revocation-propagation` | 04-oauth-provider-jwt | 1 | medium | 1 | 4 | — | SCP-007, TIR-007 |
| 93 | `security-signal-pipeline` | 02-core-events-hooks | 1 | medium | 1 | 4 | auth-event-taxonomy, auth-events-subscription | CSG-008 |
| 94 | `server-request-limits` | 13-repo-features-tooling | 1 | medium | 1 | 4 | — | NHS-004 |
| 95 | `session-cookie-expiry` | 06-server-api | 1 | medium | 1 | 4 | — | CSS-002, IC-002, NSA-004, SMS-005-session-management-specialist |
| 96 | `webauthn-user-presence` | 09-ports-apikey-cli | 1 | medium | 1 | 4 | — | BPAS-004, CB-002 |
| 97 | `bdd-step-definition-quality` | 13-repo-features-tooling | 8 | medium | 0 | 14 | — | AH-004-aslak-hellesoy, AH-007-aslak-hellesoy, TIR-005, AH-008-aslak-hellesoy, AH-009-aslak-hellesoy, BDD-007, BDD-008, CSD-009 |
| 98 | `sql-docs-operations` | 05-sql | 7 | medium | 0 | 16 | — | CSG-006, ESR-008, NAM-007, PPS-004, PPS-006, SSMS-006, ERAS-006, NAM-011, PPS-009 |
| 99 | `auth-events-subscription` | 02-core-events-hooks | 6 | medium | 0 | 6 | — | ALF-007, ESS-003-effect-stream-specialist, ESS-004, ETVS-001, MA-009, ECF-010, ESS-007-effect-stream-specialist |
| 100 | `spec-behavior-code-reconcile` | 12-spec | 6 | medium | 0 | 9 | spec-status-banner-sweep | NAM-010, AAPS-007, BO-008, BPAS-007, HSK-009, RSC-008, RZS-007, IC-006 |
| 101 | `passkey-wire-contract` | 10-passkey-admin | 5 | medium | 0 | 11 | — | AVS-003, HSK-003, AVS-006, HSK-008, WPS-010 |
| 102 | `bdd-skip-debt` | 13-repo-features-tooling | 4 | medium | 0 | 21 | — | AH-005-aslak-hellesoy, ESS-009, PHS-005, SMS-008-session-management-specialist, BDD-009 |
| 103 | `password-recovery-correctness` | 07-password-mfa | 4 | medium | 0 | 4 | — | APS-004, APS-005, ARF-002, ARF-004, CSD-008, ARF-007, ARF-008, TMS-008 |
| 104 | `per-request-session-cache` | 06-server-api | 4 | medium | 0 | 7 | — | TS-003-tim-smart, ECF-005, ELC-007, NHS-006, PCS-006 |
| 105 | `session-handler-hardening` | 06-server-api | 4 | medium | 0 | 7 | session-cookie-expiry | GC-003, GC-005, EHA-009, GC-008 |
| 106 | `session-list-liveness-and-pagination` | 05-sql | 4 | medium | 0 | 7 | retention (CSG-003, cross-slice; reaper only) | PPS-002, SMS-002-session-management-specialist, TIR-003, ESR-010, SEA-006, SSMS-008 |
| 107 | `admin-impersonation-lifecycle` | 10-passkey-admin | 3 | medium | 0 | 9 | admin-impersonation-gate-target | ESS-006-effect-stream-specialist, IDS-004, ESA-008, IDS-007, JR-011 |
| 108 | `bdd-suite-docs` | 13-repo-features-tooling | 3 | medium | 0 | 3 | — | AH-006-aslak-hellesoy, BDD-004, BDD-006, TIR-006, AH-010 |
| 109 | `build-tooling-hygiene` | 01-core-sessions-users | 3 | medium | 0 | 6 | httpapi-surface-consolidation | AH-006-anders-hejlsberg, MTS-001, ELC-004 |
| 110 | `ci-release-hardening` | 13-repo-features-tooling | 3 | medium | 0 | 6 | — | AVS-009, MM-006, MTS-006, MW-005 |
| 111 | `hook-registry-per-composition` | 02-core-events-hooks | 3 | medium | 0 | 20 | — | ELC-001, JH-003, MW-004, PERS-003, GC-006, TS-006-torin-sandall |
| 112 | `jose-algorithm-coverage` | 04-oauth-provider-jwt | 3 | medium | 0 | 12 | jwt-key-rotation-integrity, oauth-provider-boot-validation | AOMS-005, FAMS-005, BAM-010 |
| 113 | `jwt-key-rotation-integrity` | 04-oauth-provider-jwt | 3 | medium | 0 | 20 | jwt-signing-key-at-rest-encryption | JJS-003, JJS-004, KRS-006, KRS-009 |
| 114 | `org-active-context-lifecycle` | 08-authz-org-roles-qadi | 3 | medium | 0 | 9 | org-write-atomicity-and-uniqueness | CWM-003, MTI-001, DRS-008, OHS-007 |
| 115 | `password-api-contract-hygiene` | 07-password-mfa | 3 | medium | 0 | 3 | — | AR-002, AVS-004, CDS-003, ESS-006-effect-schema-specialist, EHA-007 |
| 116 | `plugin-composition-soundness` | 01-core-sessions-users | 3 | medium | 0 | 9 | httpapi-surface-consolidation | ELC-002, JH-005, JH-006, MA-005, MA-007, TS-004-torin-sandall, TTE-006, ELC-006 |
| 117 | `qadi-upstream` | 08-authz-org-roles-qadi | 3 | medium | 0 | 6 | — | PERS-002, PERS-006, PERS-007 |
| 118 | `ratelimit-distributed-store` | 09-ports-apikey-cli | 3 | medium | 0 | 14 | ratelimit-memory-eviction | AR-005, CSD-007, NHS-005, RBS-004 |
| 119 | `roles-catalog-validation` | 08-authz-org-roles-qadi | 3 | medium | 0 | 3 | — | RRM-003, RRM-004, RRM-010, TS-008, YL-005 |
| 120 | `spec-bdd-traceability-refresh` | 12-spec | 3 | medium | 0 | 6 | spec-status-banner-sweep | BDD-003, DTWS-006, DTWS-007, TMS-009 |
| 121 | `sql-repository-hygiene` | 05-sql | 3 | medium | 0 | 3 | — | EOTS-008, ESR-003, MA-008, PPS-008, ESS-011 |
| 122 | `tooling-typecheck-lint` | 13-repo-features-tooling | 3 | medium | 0 | 6 | oauth-untrusted-json-decoding (cross-slice: ESS-002-effect-schema-specialist/TTE-002/TTE-003) | AH-004-anders-hejlsberg, AH-008-anders-hejlsberg, AH-009-anders-hejlsberg |
| 123 | `workspace-roster-sync` | 13-repo-features-tooling | 3 | medium | 0 | 6 | — | MTS-003, MTS-004, MTS-005 |
| 124 | `admin-impersonation-cookie-contract` | 10-passkey-admin | 2 | medium | 0 | 5 | session-delivery | APS-006, CSS-003, IDS-005, JR-006, BAM-012 |
| 125 | `api-contract-tests` | 06-server-api | 2 | medium | 0 | 5 | — | ETVS-003, MW-008 |
| 126 | `canonical-starter-defaults` | 02-core-events-hooks | 2 | medium | 0 | 2 | — | ERAS-002, RBS-007 |
| 127 | `examples-memory-server` | 13-repo-features-tooling | 2 | medium | 0 | 2 | — | DESS-002, CSD-010 |
| 128 | `next-edge-stateless-tier` | 11-frontend-next-react-client | 2 | medium | 0 | 13 | — | BO-004, BO-006, ERAS-001, ERAS-003, BO-010 |
| 129 | `next-package-manifest-hygiene` | 11-frontend-next-react-client | 2 | medium | 0 | 2 | — | BO-003, DESS-004, MTS-002, NSA-005, ERAS-005, NSA-007 |
| 130 | `next-react-ssr-bridge` | 11-frontend-next-react-client | 2 | medium | 0 | 8 | next-package-manifest-hygiene, react-provider-subject-pipeline | RSC-005, RSC-006, EAR-007 |
| 131 | `oauth-provider-presets` | 04-oauth-provider-jwt | 2 | medium | 0 | 13 | oauth-provider-boot-validation | IC-003, NAM-003, BO-009, MW-010 |
| 132 | `passkey-user-handle` | 10-passkey-admin | 2 | medium | 0 | 8 | — | BPAS-003, BPAS-006, HSK-001, TC-002, WPS-002, CB-005 |
| 133 | `plugin-api-surface-conventions` | 04-oauth-provider-jwt | 2 | medium | 0 | 2 | — | AVS-005, AVS-007 |
| 134 | `quality-metrics-regeneration` | 13-repo-features-tooling | 2 | medium | 0 | 2 | — | AH-005-anders-hejlsberg, DESS-005, MTS-011, TS-006-tim-smart, TTE-007, NSA-009, SSMS-010, WPS-011 |
| 135 | `react-client-atoms-factory` | 11-frontend-next-react-client | 2 | medium | 0 | 5 | csrf-client-bootstrap, react-provider-subject-pipeline | BE-004, CWM-005, FAMS-008, PCS-007 |
| 136 | `roles-audit-and-admin` | 08-authz-org-roles-qadi | 2 | medium | 0 | 8 | roles-catalog-validation | PCS-003, RRM-005, YL-009 |
| 137 | `session-supersede-atomicity` | 01-core-sessions-users, 12-spec | 2 | medium | 0 | 5 | — | ESR-002, PIL-004, RRS-004, AH-007-anders-hejlsberg, ECF-007, SMS-006-session-management-specialist, TTE-004 |
| 138 | `spec-roadmap-status-reconcile` | 12-spec | 2 | medium | 0 | 2 | — | DTWS-005, MM-005 |
| 139 | `spec-surface-inventory-reconcile` | 12-spec | 2 | medium | 0 | 5 | spec-status-banner-sweep | AVS-008, DTWS-008 |
| 140 | `test-harness-completeness` | 02-core-events-hooks | 2 | medium | 0 | 8 | — | ETVS-004, SSMS-004, ETVS-005 |
| 141 | `user-import-idempotency` | 01-core-sessions-users | 2 | medium | 0 | 13 | users-identity-model | AOMS-008, MW-007, SAM-008, SCP-003 |
| 142 | `users-profile-surface` | 01-core-sessions-users | 2 | medium | 0 | 44 | users-identity-model | BAM-009, BE-007, SAM-004, SCP-004 |
| 143 | `verification-store-hygiene` | 05-sql | 2 | medium | 0 | 2 | — | PPS-003, SSMS-003, ESR-005, ESS-010 |
| 144 | `accounts-targeted-writes` | 01-core-sessions-users | 1 | medium | 0 | 4 | — | RRS-006 |
| 145 | `admin-api-tier` | 10-passkey-admin | 1 | medium | 0 | 12 | admin-surface-expansion | AR-003 |
| 146 | `auth-event-external-delivery` | 02-core-events-hooks | 1 | medium | 0 | 32 | auth-event-envelope, auth-event-schema | CWM-004, MAPS-010 |
| 147 | `auth-event-pii-posture` | 02-core-events-hooks | 1 | medium | 0 | 4 | auth-event-schema | ESA-005, ALF-009 |
| 148 | `authz-model-boundaries` | 08-authz-org-roles-qadi | 1 | medium | 0 | 1 | org-qadi-relationships | MTI-007, RRM-006, YL-002 |
| 149 | `bdd-plugin-coverage` | 12-spec | 1 | medium | 0 | 12 | jwt-key-rotation-runbook | BDD-005 |
| 150 | `cli-seed-admin-audit` | 12-spec | 1 | medium | 0 | 1 | — | ECS-006 |
| 151 | `client-native-bearer-mode` | 11-frontend-next-react-client | 1 | medium | 0 | 4 | — | MNA-006 |
| 152 | `client-promise-facade-errors` | 11-frontend-next-react-client | 1 | medium | 0 | 1 | — | DESS-003, EHA-005 |
| 153 | `cors-posture` | 06-server-api | 1 | medium | 0 | 4 | csrf-hardening, wire-constant-single-source | AGA-002, CDS-008 |
| 154 | `device-authorization-grant` | 13-repo-features-tooling | 1 | medium | 0 | 4 | — | DAG-005, DAG-001 |
| 155 | `events-delivery-durability` | 13-repo-features-tooling | 1 | medium | 0 | 4 | — | ESA-003 |
| 156 | `jwt-act-claim` | 10-passkey-admin | 1 | medium | 0 | 1 | — | JR-005 |
| 157 | `jwt-key-rotation-runbook` | 12-spec | 1 | medium | 0 | 4 | spec-status-banner-sweep | KRS-008, MAPS-009, VB-007 |
| 158 | `m2m-client-secret-lifecycle` | 12-spec | 1 | medium | 0 | 1 | — | OCM-005 |
| 159 | `oauth-callback-error-contract` | 03-oauth-flow | 1 | medium | 0 | 1 | oauth-oidc-claims-integrity | AP-005, JR-003, OAP-003 |
| 160 | `oauth-token-endpoint-client-auth` | 03-oauth-flow | 1 | medium | 0 | 4 | oauth-provider-response-decoding | AP-006 |
| 161 | `org-sql-count-queries` | 08-authz-org-roles-qadi | 1 | medium | 0 | 1 | org-write-atomicity-and-uniqueness | MTI-005, PPS-005, OHS-008 |
| 162 | `passkey-browser-signals` | 13-repo-features-tooling | 1 | medium | 0 | 4 | — | TC-004 |
| 163 | `password-hasher-legacy-recipes` | 12-spec | 1 | medium | 0 | 1 | — | SAM-002 |
| 164 | `persistence-colocation-invariant` | 03-oauth-flow | 1 | medium | 0 | 1 | — | DRS-006 |
| 165 | `property-based-testing` | 13-repo-features-tooling | 1 | medium | 0 | 4 | — | ETVS-002 |
| 166 | `provider-token-storage` | 03-oauth-flow | 1 | medium | 0 | 4 | — | BAM-008, NAM-008, RRS-007 |
| 167 | `qadi-attribute-typing` | 06-server-api | 1 | medium | 0 | 4 | attributeresolver-registry (AAPS-002, slice 08) | AAPS-003 |
| 168 | `redaction-guarantee-check` | 12-spec | 1 | medium | 0 | 12 | — | SMS-003-secrets-management-specialist |
| 169 | `session-assurance` | 10-passkey-admin | 1 | medium | 0 | 12 | — | HSK-005 |
| 170 | `session-delivery` | 10-passkey-admin | 1 | medium | 0 | 4 | — | WPS-004 |
| 171 | `session-lifecycle-events` | 12-spec | 1 | medium | 0 | 4 | — | ESA-006 |
| 172 | `session-list-correctness` | 01-core-sessions-users | 1 | medium | 0 | 4 | — | ESS-005-effect-stream-specialist, PIL-003, VB-001 |
| 173 | `session-revocation-events` | 10-passkey-admin | 1 | medium | 0 | 4 | — | TIR-008 |
| 174 | `tsconfig-paths-drift` | 09-ports-apikey-cli | 1 | medium | 0 | 1 | — | MM-002 |
| 175 | `user-claims-store` | 08-authz-org-roles-qadi | 1 | medium | 0 | 4 | — | FAMS-004 |
| 176 | `csrf-hardening` | 06-server-api | 2 | low | 2 | 5 | hmac-secret-hygiene | CDS-004, CDS-005, CDS-006, MNA-008, PDR-007 |
| 177 | `auth-event-schema` | 02-core-events-hooks | 3 | low | 1 | 14 | — | ESA-007, GC-007, IDS-006 |
| 178 | `oauth-config-safety` | 03-oauth-flow | 2 | low | 1 | 2 | — | AGA-005, PDR-005 |
| 179 | `session-verify-hardening` | 01-core-sessions-users | 2 | low | 1 | 5 | — | RRS-005, IDS-008, PIL-007, SMS-007-session-management-specialist |
| 180 | `verification-hardening` | 01-core-sessions-users | 2 | low | 1 | 2 | — | ACS-002, MLO-004, MLO-006, TSS-005 |
| 181 | `dev-scripts-tooling` | 13-repo-features-tooling | 6 | low | 0 | 6 | — | ELC-003, MM-003, MM-007, MM-009, MM-010, MTS-009 |
| 182 | `optional-auth-contract` | 06-server-api | 3 | low | 0 | 6 | bearer-credential-extensibility (sequence only: both edit the bearer handler) | EHA-006, JR-007, NHS-010 |
| 183 | `package-and-test-hygiene` | 10-passkey-admin | 2 | low | 0 | 2 | — | MTS-010, TTE-009 |
| 184 | `sql-contract-test-coverage` | 05-sql | 2 | low | 0 | 5 | sql-dialect-neutral-models (ESR-009's shared contract cases) | SEA-004, SEA-005 |
| 185 | `bdd-organization-feature` | 13-repo-features-tooling | 1 | low | 0 | 12 | bdd-suite-docs | CWM-006, MTI-011 |
| 186 | `cli-migration-guardrails` | 12-spec | 1 | low | 0 | 4 | cli-exit-code-and-arg-contract | ECS-009 |
| 187 | `coverage-enforcement` | 13-repo-features-tooling | 1 | low | 0 | 1 | — | ETVS-007, MM-004 |
| 188 | `csrf-client-bootstrap` | 11-frontend-next-react-client | 1 | low | 0 | 4 | — | PDR-002, EHA-003, CDS-007, DESS-009 |
| 189 | `design-docs-archive` | 13-repo-features-tooling | 1 | low | 0 | 1 | — | ELC-005 |
| 190 | `passkey-docs` | 10-passkey-admin | 1 | low | 0 | 1 | — | WPS-012, TC-007 |
| 191 | `phc-hash-branding` | 09-ports-apikey-cli | 1 | low | 0 | 4 | legacy-password-migration, password-hasher-offload, password-hasher-verify-hardening | TTE-005 |
| 192 | `plugin-contract-docs` | 10-passkey-admin | 1 | low | 0 | 1 | — | JH-007 |
| 193 | `plugin-port-boundary-enforcement` | 04-oauth-provider-jwt | 1 | low | 0 | 4 | — | JH-008 |
| 194 | `react-package-deps` | 11-frontend-next-react-client | 1 | low | 0 | 1 | — | MM-001, BO-007, DESS-006 |
| 195 | `retention-sweeps` | 05-sql | 1 | low | 0 | 4 | retention (CSG-003, cross-slice) | ALF-010 |
| 196 | `roles-permission-modeling` | 13-repo-features-tooling | 1 | low | 0 | 1 | — | YL-006, RRM-008 |
| 197 | `session-authentication-methods` | 04-oauth-provider-jwt | 1 | low | 0 | 12 | — | AOMS-012 |
| 198 | `sqlite-ops-docs` | 12-spec | 1 | low | 0 | 1 | — | SEA-003 |
| 199 | `user-profile-image` | 04-oauth-provider-jwt | 1 | low | 0 | 4 | — | NAM-009 |
| 200 | `wire-constant-single-source` | 06-server-api | 1 | low | 0 | 1 | httpapi-surface-consolidation (MW-002, slice 01) adds the same core->api dependency; coordinate | BE-009, CSS-007, EHA-008, MW-009 |
| 201 | `native-bearer-bootstrap` | 12-spec | 1 | info | 0 | 1 | — | MNA-009 |
| 202 | `spec-model-drift` | 09-ports-apikey-cli | 1 | info | 0 | 1 | — | JJS-010 |
| 203 | `verification-timing-uniformity` | 12-spec | 1 | info | 0 | 1 | — | MLO-008 |
| 204 | `api-path-param-conventions` | 03-oauth-flow | 0 | — | 0 | 0 | — | AVS-010 |
| 205 | `m2m-identity` | 06-server-api | 0 | — | 0 | 0 | — | OCM-003 |
| 206 | `m2m-machine-credentials` | 04-oauth-provider-jwt | 0 | — | 0 | 0 | — | OCM-007, OCM-006 |
| 207 | `migration-wiring` | 05-sql | 0 | — | 0 | 0 | cli migration tooling (BE-003, cli slice) | SSMS-005 |
| 208 | `none` | 06-server-api | 0 | — | 0 | 0 | — | AGA-006, TS-007-tim-smart |
| 209 | `oauth-callback-url-policy` | 03-oauth-flow | 0 | — | 0 | 0 | — | APS-002, TMS-003, PDR-006 |

# Programs (roll-up)

| Program | Phase | Open | high | medium | low | info | Decisions | Est. hours |
|---|---|---|---|---|---|---|---|---|
| [P01 Session integrity & cookie/CSRF correctness](programs/P01-session-integrity-cookie-csrf-correctness.md) | 1 | 44 | 0 | 22 | 21 | 1 | 3 | 125 |
| [P02 OAuth / OIDC flow hardening](programs/P02-oauth-oidc-flow-hardening.md) | 1 | 35 | 3 | 21 | 10 | 1 | 4 | 64 |
| [P03 JWT, signing keys & key rotation](programs/P03-jwt-signing-keys-key-rotation.md) | 1 | 23 | 4 | 11 | 7 | 1 | 2 | 92 |
| [P04 Authorization: organizations, roles, qadi](programs/P04-authorization-organizations-roles-qadi.md) | 1 | 54 | 8 | 32 | 11 | 3 | 4 | 198 |
| [P05 Admin & impersonation](programs/P05-admin-impersonation.md) | 1 | 12 | 3 | 7 | 1 | 1 | 3 | 91 |
| [P06 Rate limiting & abuse resistance](programs/P06-rate-limiting-abuse-resistance.md) | 1 | 10 | 1 | 7 | 2 | 0 | 0 | 39 |
| [P07 Password, hashing, mail & verification tokens](programs/P07-password-hashing-mail-verification-tokens.md) | 2 | 37 | 4 | 20 | 12 | 1 | 3 | 86 |
| [P08 Passkeys / WebAuthn](programs/P08-passkeys-webauthn.md) | 2 | 25 | 0 | 16 | 8 | 1 | 2 | 58 |
| [P09 Persistence: SQL dialects, repositories, replicas](programs/P09-persistence-sql-dialects-repositories-replicas.md) | 2 | 19 | 2 | 7 | 8 | 2 | 1 | 79 |
| [P10 Events, hooks & observability](programs/P10-events-hooks-observability.md) | 2 | 33 | 6 | 19 | 8 | 0 | 1 | 133 |
| [P11 Compliance: erasure, export, retention, redaction](programs/P11-compliance-erasure-export-retention-redaction.md) | 2 | 7 | 2 | 4 | 1 | 0 | 3 | 57 |
| [P12 Composition, API surface & error taxonomy](programs/P12-composition-api-surface-error-taxonomy.md) | 2 | 16 | 1 | 10 | 5 | 0 | 1 | 73 |
| [P13 Frontend: Next.js, React, client](programs/P13-frontend-next-js-react-client.md) | 2 | 29 | 5 | 10 | 13 | 1 | 1 | 78 |
| [P14 Identity model & user lifecycle](programs/P14-identity-model-user-lifecycle.md) | 3 | 10 | 3 | 5 | 2 | 0 | 1 | 134 |
| [P15 MFA, passwordless & authentication assurance](programs/P15-mfa-passwordless-authentication-assurance.md) | 3 | 19 | 6 | 10 | 3 | 0 | 1 | 131 |
| [P16 Native, bearer & machine identity](programs/P16-native-bearer-machine-identity.md) | 3 | 16 | 8 | 7 | 0 | 1 | 2 | 120 |
| [P17 CLI tooling](programs/P17-cli-tooling.md) | 3 | 16 | 6 | 9 | 1 | 0 | 0 | 115 |
| [P18 Multi-tenancy, residency & enterprise federation](programs/P18-multi-tenancy-residency-enterprise-federation.md) | 4 | 16 | 5 | 7 | 1 | 3 | 4 | 194 |
| [P19 Spec & documentation truthfulness](programs/P19-spec-documentation-truthfulness.md) | 0 | 27 | 1 | 7 | 15 | 4 | 0 | 42 |
| [P20 Test suite, tooling & CI](programs/P20-test-suite-tooling-ci.md) | 0 | 49 | 1 | 24 | 22 | 2 | 3 | 152 |
