---
ID: "BCR-007"
Title: "better-auth design contract keeps a plaintext backup-code read path that contradicts the repo's own recommendation"
Level: medium
Category: "docs"
Status: needs-triage
Package: "—"
Source: "better-auth/05-mfa-and-verification/01-two-factor.md:311"
Auditor: "backup-codes-recovery-specialist"
Auditor-Type: "archetype"
Audit-Date: 2026-09-19
---
# BCR-007 — better-auth design contract keeps a plaintext backup-code read path that contradicts the repo's own recommendation

`MEDIUM` · `docs` · `—` · reported by **Backup Codes & Account Recovery Specialist** (`backup-codes-recovery-specialist`)

Status: **needs-triage**

## Summary

The reference design adapted from better-auth stores backupCodes 'encoded per storeBackupCodes policy' and reserves a server-only viewBackupCodes operation returning the plaintext array — exactly the 'reversibly encrypted for support purposes' pattern the persona's rubric flags as a red flag, and in direct tension with research/07's normative recommendation 4 (SHA-256-hashed, delete-on-use, no read-back). Nothing yet reconciles the two documents, so an implementer starting from the design contract could ship reversible code storage.

## Evidence

Source: `better-auth/05-mfa-and-verification/01-two-factor.md:311`

```
Ensures:       returns the plaintext backup-code array for that user
```

## Recommended fix

Amend the design contract (or add a decision note in spec/decisions) stating awthaq backup codes are hashed irreversibly with no plaintext read path, and that viewBackupCodes is deliberately not implemented; keep show-once via issue's one-time Redacted value return.

## Context

- Auditor verdict on this domain: **needs-work** (score 46/100), domain: Backup Codes & Recovery
- Full dossier: [`backup-codes-recovery-specialist`](../../.reports/backup-codes-recovery-specialist/index.html) · Board: [`dashboard`](../../.reports/index.html)
- Auditor read 20 files in this domain; this finding's source was read directly during the audit.

## Comments

_Triage notes and discussion append here._

**Plan validation (2026-09-29):** INVALID (confidence high); workstream `None`. Evidence at HEAD ec065a7: `better-auth/05-mfa-and-verification/01-two-factor.md:304`. Recommended `wontfix` — pending confirmation (`.plan/README.md` §7); Status left unchanged. Full dossier: `.plan/slices/13-repo-features-tooling.md`.
