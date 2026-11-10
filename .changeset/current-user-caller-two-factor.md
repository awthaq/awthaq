---
"@awthaq/two-factor": minor
---

Two-factor handlers read the domain caller from `CurrentUser.current` instead of re-branding the wire principal.

Migration: TwoFactorShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).
