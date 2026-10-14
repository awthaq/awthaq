---
"@awthaq/saml": patch
---

SAML first login creates its user through `SignUp` (ADR-EA-038): `BeforeSignUp` vets it, and the user and IdP account are one unit announced only after it commits.
