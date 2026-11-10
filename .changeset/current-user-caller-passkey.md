---
"@awthaq/passkey": minor
"@awthaq/password": patch
---

Passkey and password handlers read the domain caller from `CurrentUser.current` instead of re-branding the wire principal.

Migration: PasskeyShape session parameters take Sessions.SessionId; pass the issued session's id or Sessions.SessionId(raw).
