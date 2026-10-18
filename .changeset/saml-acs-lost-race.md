---
"@awthaq/saml": patch
"@awthaq/test": minor
---

Two concurrent ACS requests for one new NameID no longer answer 500 (or reject the second); the second signs in as the user the first created or linked (BEH-EA-245). `@awthaq/test` gains `Rendezvous` for tests that force an interleaving.
