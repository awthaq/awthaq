---
"@awthaq/oauth": patch
"@awthaq/saml": patch
---

`OAuth.callback` refuses a `state` that names another purpose's verification token before consuming it, so a crafted state can no longer spend another flow's attempts (BEH-EA-057, BEH-EA-122). OAuth and SAML state use the shared `VerificationLink` codec.

Migration: none.
