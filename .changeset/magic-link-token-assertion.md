---
---

Tests only: `MagicLink.test.ts` no longer asserts that a random token lacks the substring "ada" (a flake roughly once in a few thousand runs); it asserts the token carries neither the whole address nor its base64url encoding. No package behaviour changes.
